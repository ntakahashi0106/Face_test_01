/**
 * scene-loader: エディタが書き出した SceneDocument(JSON) を three.js シーンに組み立てる。
 *
 * - エディタ側 viewport と同じプリミティブ解釈を行う（回転はオイラー角・度数法・XYZ順）
 * - メディアアセット（GLB/glTF・画像）は assets/media/ からfetch、または
 *   エディタプレビューから注入された ArrayBuffer を使う
 * - ARエンジン(XR8.*)には依存しない。'three' / 'three/addons/' の import は
 *   バンドルの importmap（./vendor/）またはエディタのVite解決で賄われる
 * - このファイルは書き出しバンドルでは runtime/scene-loader.js として配置される
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { createParticleSystem, loadTexture as loadParticleTexture } from './particle-system.js';

const MESH_COLOR = 0x7f8cff;

/**
 * Draco圧縮GLB用デコーダの配置パス。
 * デフォルトは書き出しバンドルの配置（index.htmlからの相対）。
 * エディタ（dev）は setDracoDecoderPath('/three-draco/') で上書きする。
 */
let dracoDecoderPath = 'vendor/three-addons/libs/draco/';

export function setDracoDecoderPath(path) {
  dracoDecoderPath = path;
  cachedGltfLoader = null; // パス変更後に作り直す
}

let cachedGltfLoader = null;

function getGltfLoader() {
  if (!cachedGltfLoader) {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(dracoDecoderPath);
    cachedGltfLoader = new GLTFLoader();
    cachedGltfLoader.setDRACOLoader(dracoLoader);
    cachedGltfLoader.setMeshoptDecoder(MeshoptDecoder);
  }
  return cachedGltfLoader;
}

function buildGeometry(type) {
  switch (type) {
    case 'cube':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 32, 16);
    case 'plane': {
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2); // エディタと同じく水平面をデフォルトにする
      return g;
    }
    case 'cylinder':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case 'cone':
      return new THREE.ConeGeometry(0.5, 1, 32);
    default:
      return null; // 'empty' / 'model' / 'image' / 未知の種別はグループとして扱う
  }
}

/**
 * GLBモデル内のマテリアルへ描画設定（components.materialSettings）を適用する。
 *
 * 半透明マテリアル同士の描画順ソート問題（見る角度によって手前の透過メッシュが
 * 奥に描かれる）への対処で、Unityのrender queue / マテリアル描画順設定に相当する。
 * ビューポート・ARプレビュー・書き出し後のARのすべてが本関数を通る（単一ソース原則）。
 *
 * @param {THREE.Object3D} root モデルのルートノード
 * @param {Record<string, object>|undefined} settingsByName マテリアル名 → MaterialRenderSettings
 */
export function applyMaterialSettings(root, settingsByName) {
  if (!settingsByName || typeof settingsByName !== 'object') return;
  root.traverse((child) => {
    if (!child.isMesh) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      const s = settingsByName[material.name];
      if (!s) continue;

      // 描画順はメッシュ(Object3D)単位。大きいほど後（=手前）に描画される
      if (typeof s.renderOrder === 'number' && s.renderOrder !== 0) {
        child.renderOrder = s.renderOrder;
      }

      switch (s.alphaMode) {
        case 'opaque':
          material.transparent = false;
          material.alphaTest = 0;
          material.depthWrite = true;
          break;
        case 'cutout': {
          // アルファテスト: 深度書き込みされるためソート問題が起きない
          const threshold = typeof s.alphaTestThreshold === 'number' ? s.alphaTestThreshold : 0.5;
          material.transparent = false;
          material.alphaTest = Math.min(Math.max(threshold, 0.01), 1);
          material.depthWrite = true;
          break;
        }
        case 'blend':
          material.transparent = true;
          material.alphaTest = 0;
          break;
        default:
          break; // 'inherit': GLBの設定のまま
      }

      if (s.depthWrite === 'on') material.depthWrite = true;
      else if (s.depthWrite === 'off') material.depthWrite = false;

      material.needsUpdate = true;
    }
  });
}

/**
 * GLB/glTF の ArrayBuffer から three.js ノードを生成する（Draco/meshopt圧縮対応）。
 * アニメーションが含まれる場合は AnimationMixer を生成して全クリップを
 * ループ再生状態にし、node.userData.mixer に格納する
 * （毎フレーム mixer.update(delta) を呼ぶのは表示側の責務）。
 * @param {ArrayBuffer} arrayBuffer
 * @param {Record<string, object>} [materialSettings] マテリアル名 → MaterialRenderSettings
 */
export async function loadModelNode(arrayBuffer, materialSettings) {
  const gltf = await getGltfLoader().parseAsync(arrayBuffer, '');
  const node = gltf.scene;
  applyMaterialSettings(node, materialSettings);
  if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
    const mixer = new THREE.AnimationMixer(node);
    for (const clip of gltf.animations) {
      mixer.clipAction(clip).play();
    }
    node.userData.mixer = mixer;
  }
  // サイズの妥当性チェック（単位違いのモデルに気づけるようログを残す）
  const box = new THREE.Box3().setFromObject(node);
  if (box.isEmpty()) {
    console.warn('[webar-tool] GLBの読み込みは成功しましたが、表示可能なメッシュがありません');
  } else {
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 100 || (maxDim > 0 && maxDim < 0.01)) {
      console.warn(
        `[webar-tool] GLBのサイズが極端です（最大寸法 ${maxDim.toFixed(4)}m）。` +
          `カメラから見えない可能性があるため、Inspectorでスケールを調整してください`,
      );
    }
  }
  return node;
}

/** 画像の ArrayBuffer から縦横比を保ったテクスチャ平面（高さ1）を生成する */
export async function loadImageNode(arrayBuffer, mime) {
  const url = URL.createObjectURL(new Blob([arrayBuffer], { type: mime }));
  try {
    const texture = await new THREE.TextureLoader().loadAsync(url);
    texture.colorSpace = THREE.SRGBColorSpace;
    const aspect =
      texture.image && texture.image.height > 0 ? texture.image.width / texture.image.height : 1;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(aspect, 1),
      new THREE.MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: THREE.DoubleSide,
      }),
    );
    return mesh;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Lottie(JSON) の ArrayBuffer から縦横比を保ったアニメーション平面（高さ1）を生成する。
 * lottie-web のcanvasレンダラで描画し、CanvasTexture をテクスチャとして使う。
 * lottie-web 自身が rAF でcanvasを更新するため、表示側は毎フレーム
 * texture.needsUpdate を立てるだけでよい（userData.mixer の update で行う）。
 * lottie-web は Lottieアセットがあるときだけ動的importする
 * （書き出しバンドルでは vendor/lottie-web.js。importmapで解決）。
 */
export async function loadLottieNode(arrayBuffer) {
  const animationData = JSON.parse(new TextDecoder().decode(arrayBuffer));
  const { default: lottie } = await import('lottie-web');

  const width = Number(animationData.w) > 0 ? Number(animationData.w) : 512;
  const height = Number(animationData.h) > 0 ? Number(animationData.h) : 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const animation = lottie.loadAnimation({
    renderer: 'canvas',
    loop: true,
    autoplay: true,
    animationData,
    rendererSettings: {
      context: canvas.getContext('2d'),
      clearCanvas: true,
    },
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const aspect = width / height;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(aspect, 1),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = 'lottie';
  // AnimationMixerと同じ update インターフェースでテクスチャ更新を流し込む
  mesh.userData.mixer = {
    update: () => {
      texture.needsUpdate = true;
    },
  };
  mesh.userData.lottieAnimation = animation;
  return mesh;
}

/**
 * メディアアセットのバイナリを解決する。
 * @param {object} doc SceneDocument
 * @param {Map<string, ArrayBuffer>} [providedData] エディタプレビューから注入されるバイナリ
 * @returns {Promise<Map<string, {asset: object, data: ArrayBuffer}>>}
 */
export async function loadAssetLibrary(doc, providedData) {
  const library = new Map();
  for (const asset of doc.mediaAssets || []) {
    let data = providedData?.get(asset.id) ?? null;
    if (!data && asset.url) {
      const res = await fetch(asset.url);
      if (!res.ok) {
        console.warn(`[webar-tool] アセット ${asset.name} (${asset.url}) の取得に失敗しました`);
        continue;
      }
      data = await res.arrayBuffer();
    }
    if (!data) {
      console.warn(`[webar-tool] アセット ${asset.name} のデータがありません`);
      continue;
    }
    library.set(asset.id, { asset, data });
  }
  return library;
}

async function buildNode(obj, assetLibrary, mixers) {
  let node;
  const geometry = buildGeometry(obj.type);
  if (geometry) {
    const material = new THREE.MeshStandardMaterial({
      color: MESH_COLOR,
      roughness: 0.6,
      metalness: 0.05,
      side: obj.type === 'plane' ? THREE.DoubleSide : THREE.FrontSide,
    });
    node = new THREE.Mesh(geometry, material);
  } else if (obj.type === 'particles') {
    // パーティクルは参照画像が無くても（単色の点として）構築する
    node = new THREE.Group();
    try {
      const entry = obj.geometryRef ? assetLibrary.get(obj.geometryRef) : undefined;
      const texture = entry ? await loadParticleTexture(entry.data, entry.asset.mime) : null;
      const { object: points, mixer } = createParticleSystem(
        obj.components?.particleSystem,
        texture,
      );
      node.add(points);
      mixers.push(mixer);
    } catch (err) {
      console.warn(`[webar-tool] パーティクルシステムの構築に失敗しました（${obj.name}）:`, err);
    }
  } else {
    node = new THREE.Group();
    // メディアアセット参照ノードは中身を非同期ロードしてグループに入れる
    const entry = obj.geometryRef ? assetLibrary.get(obj.geometryRef) : undefined;
    if (entry) {
      try {
        let content = null;
        if (obj.type === 'model') {
          content = await loadModelNode(entry.data, obj.components?.materialSettings);
        } else if (obj.type === 'image') {
          content = await loadImageNode(entry.data, entry.asset.mime);
        } else if (obj.type === 'lottie') {
          content = await loadLottieNode(entry.data);
        }
        if (content) {
          node.add(content);
          if (content.userData.mixer) mixers.push(content.userData.mixer);
        }
      } catch (err) {
        console.warn(`[webar-tool] アセット ${entry.asset.name} のロードに失敗しました:`, err);
      }
    }
  }
  node.name = obj.name;
  node.visible = obj.visible !== false;
  const t = obj.transform || {};
  const p = t.position || [0, 0, 0];
  const r = t.rotation || [0, 0, 0];
  const s = t.scale || [1, 1, 1];
  node.position.set(p[0], p[1], p[2]);
  node.rotation.set(
    THREE.MathUtils.degToRad(r[0]),
    THREE.MathUtils.degToRad(r[1]),
    THREE.MathUtils.degToRad(r[2]),
    'XYZ',
  );
  node.scale.set(s[0], s[1], s[2]);
  return node;
}

/**
 * SceneDocument からオブジェクトツリーを構築する（メディアアセトのロードを含むため非同期）。
 * 戻り値の roots（ルート直下オブジェクト）をどこに add するかは
 * 各ARモードのランタイムが決める（マーカーアンカー / 顔アンカー等）。
 *
 * @param {object} doc SceneDocument (scene.json)
 * @param {Map<string, {asset: object, data: ArrayBuffer}>} [assetLibrary] loadAssetLibraryの結果
 * @returns {Promise<{ byId: Map<string, THREE.Object3D>, roots: Array<{object: object, node: THREE.Object3D}>, mixers: Array<THREE.AnimationMixer> }>}
 */
export async function buildSceneNodes(doc, assetLibrary = new Map()) {
  const objects = Array.isArray(doc.objects) ? doc.objects : [];
  const byId = new Map();
  const mixers = [];
  for (const obj of objects) {
    byId.set(obj.id, await buildNode(obj, assetLibrary, mixers));
  }
  const roots = [];
  for (const obj of objects) {
    const node = byId.get(obj.id);
    const parent = obj.parentId !== null ? byId.get(obj.parentId) : undefined;
    if (parent) {
      parent.add(node);
    } else {
      roots.push({ object: obj, node });
    }
  }
  return { byId, roots, mixers };
}

/**
 * AnimationMixer群を毎フレーム進める更新関数を作る。
 * ランタイムはパイプラインモジュールの onUpdate から、
 * エディタのビューポートは描画ループから呼ぶ。
 */
export function createAnimationUpdater(mixers) {
  if (!mixers || mixers.length === 0) return () => {};
  const clock = new THREE.Clock();
  return () => {
    const delta = clock.getDelta();
    for (const mixer of mixers) mixer.update(delta);
  };
}

/** エディタの viewport と同等のライティングを追加する */
export function addDefaultLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.6);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);
}

/** fetch + JSONパース（失敗時は分かりやすいエラーを投げる） */
export async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} の取得に失敗しました (HTTP ${res.status})`);
  }
  return res.json();
}
