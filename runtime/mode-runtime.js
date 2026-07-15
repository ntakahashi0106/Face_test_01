/**
 * フェイストラッキングAR ランタイム（Face Effects / OSSエンジン範囲）。
 *
 * - 顔の検出結果（頭部Transform + アタッチメントポイント）に
 *   シーンオブジェクトを追従させる。
 * - faceAnchor コンポーネントの attachPoint（forehead / noseTip 等）ごとに
 *   サブグループを作り、未設定オブジェクトは頭部原点(origin)に追従させる。
 * - XR8.* / XRExtras.* の呼び出しはランタイム層（このファイル）に閉じ込める。
 * - 書き出しバンドルでは runtime/mode-runtime.js として配置され、生成された
 *   runtime/main.js が start() を呼ぶ。エディタ内プレビューも同じ start() を使う。
 *
 * @param {object} [options]
 * @param {object} [options.doc] SceneDocument。省略時は ./scene.json をfetch
 * @param {HTMLCanvasElement} [options.canvas] 描画先。省略時は #camerafeed
 */
import {
  buildSceneNodes,
  createAnimationUpdater,
  loadAssetLibrary,
  addDefaultLights,
  loadJson,
} from './scene-loader.js';
import { setupPhotoCapture, teardownPhotoCapture } from './photo-capture.js';
import { createScriptRuntime } from './script-engine.js';
import { createSplash, teardownSplash } from './splash.js';
import { setupLegalFooter, teardownLegalFooter } from './legal-footer.js';
import {
  setupFullWindowCanvas,
  teardownFullWindowCanvas,
} from './fullwindow-canvas.js';
import { createErrorDetailModule } from './error-display.js';

function scenePipelineModule(doc, THREE, built, canvas, splash) {
  const { roots, byId, mixers } = built;
  const updateAnimations = createAnimationUpdater(mixers);
  let scriptRuntime = null;
  /** 頭部全体を表すグループ（検出中のみ visible） */
  let headGroup = null;
  /** attachPoint名 → headGroup配下のサブグループ */
  const attachGroups = new Map();

  const onFaceUpdated = (detail) => {
    if (!headGroup) return;
    headGroup.visible = true;
    if (detail.transform) {
      headGroup.position.copy(detail.transform.position);
      headGroup.quaternion.copy(detail.transform.rotation);
      const s = detail.transform.scale;
      headGroup.scale.set(s, s, s);
    }
    // アタッチメントポイント（頭部ローカル座標）を更新する
    const points = detail.attachmentPoints || {};
    for (const [name, group] of attachGroups) {
      if (name === 'origin') continue;
      const point = points[name];
      if (point && point.position) {
        group.position.copy(point.position);
      }
    }
  };

  return {
    name: 'webar-tool-face-scene',
    onStart: () => {
      const { scene } = window.XR8.Threejs.xrScene();
      addDefaultLights(scene);

      headGroup = new THREE.Group();
      headGroup.name = 'anchor:face';
      headGroup.visible = false;
      scene.add(headGroup);

      const originGroup = new THREE.Group();
      originGroup.name = 'face:origin';
      headGroup.add(originGroup);
      attachGroups.set('origin', originGroup);

      // 使用されている attachPoint のサブグループだけを作る（rootsはstart()で事前構築済み）
      for (const { object, node } of roots) {
        const attachPoint = object.components?.faceAnchor?.attachPoint ?? 'origin';
        let group = attachGroups.get(attachPoint);
        if (!group) {
          group = new THREE.Group();
          group.name = `face:${attachPoint}`;
          headGroup.add(group);
          attachGroups.set(attachPoint, group);
        }
        group.add(node);
      }

      // スクリプトコンポーネントの実行開始（scene/camera確定後）
      const { camera } = window.XR8.Threejs.xrScene();
      scriptRuntime = createScriptRuntime(doc, byId, { scene, camera, canvas });
      scriptRuntime.start();

      // AR準備完了 → スプラッシュを閉じる（tapモードはスタートボタン表示）
      splash.ready();
    },
    onUpdate: () => {
      updateAnimations();
      scriptRuntime?.update();
    },
    listeners: [
      { event: 'facecontroller.facefound', process: ({ detail }) => onFaceUpdated(detail) },
      { event: 'facecontroller.faceupdated', process: ({ detail }) => onFaceUpdated(detail) },
      {
        event: 'facecontroller.facelost',
        process: () => {
          if (headGroup) headGroup.visible = false;
        },
      },
    ],
  };
}

function waitForEngine() {
  return new Promise((resolve) => {
    if (window.XR8) resolve();
    else window.addEventListener('xrloaded', resolve, { once: true });
  });
}

export async function start(options = {}) {
  const THREE = await import('three');
  // XR8.Threejs.pipelineModule() はグローバルTHREEを必要とする
  if (!window.THREE) window.THREE = THREE;
  const doc = options.doc ?? (await loadJson('./scene.json'));
  const canvas = options.canvas ?? document.getElementById('camerafeed');

  // メディアアセット（GLB/画像）を含むシーンノードを事前構築する
  const assetLibrary = await loadAssetLibrary(doc, options.assetData);

  // スプラッシュ画面（エンジン/カメラ読み込み中の目隠しを兼ねるため最初に出す）
  const splash = createSplash(doc, assetLibrary);

  const built = await buildSceneNodes(doc, assetLibrary);

  await waitForEngine();
  const XR8 = window.XR8;
  const XRExtras = window.XRExtras;

  // XRExtras不在時は自前でcanvasを全画面に合わせる（FullWindowCanvas代替。
  // バッファサイズが表示サイズとずれるとカメラ映像が左上に小さく描かれる）
  if (!XRExtras) setupFullWindowCanvas(canvas);

  // スタンドアロン配布のエンジンはチャンク遅延ロード方式。
  // FaceController は xr-face.js チャンクに含まれるため、
  // data-preload-chunks 未指定でも動くようここで確実にロードする
  if (!XR8.FaceController && typeof XR8.loadChunk === 'function') {
    await XR8.loadChunk('face');
  }
  // xr.js本体のカメラ処理がフェイスセッションでも
  // XR8.XrController.updateCameraProjectionMatrix を無条件に参照するため、
  // XrController を含む slam チャンクもロードしておく（無いと起動時にクラッシュする）
  if (!XR8.XrController && typeof XR8.loadChunk === 'function') {
    await XR8.loadChunk('slam');
  }

  // 再起動（エディタプレビューの開き直し等）に備えて前回のモジュールを破棄する
  XR8.clearCameraPipelineModules?.();

  // フォトフレーム（撮影）機能。シーン設定で無効なら何もしない
  const photo = setupPhotoCapture(doc, assetLibrary, { canvas });

  // 8th Wall Engineライセンス準拠のための法的表示（常時表示・無効化不可）
  setupLegalFooter(doc);

  XR8.FaceController.configure({
    meshGeometry: [],
    coordinates: { mirroredDisplay: true },
    maxDetections: 1,
  });

  XR8.addCameraPipelineModules([
    XR8.GlTextureRenderer.pipelineModule(),
    XR8.FaceController.pipelineModule(),
    XR8.Threejs.pipelineModule(),
    ...(XRExtras
      ? [
          // 非対応ブラウザ（アプリ内WebView等）では「ブラウザで開いてください」画面を出す
          ...(XRExtras.AlmostThere ? [XRExtras.AlmostThere.pipelineModule()] : []),
          XRExtras.FullWindowCanvas.pipelineModule(),
          XRExtras.Loading.pipelineModule(),
          XRExtras.RuntimeError.pipelineModule(),
        ]
      : []),
    createErrorDetailModule(),
    ...photo.pipelineModules,
    scenePipelineModule(doc, THREE, built, canvas, splash),
  ]);

  XR8.run({
    canvas,
    // フェイストラッキングはフロントカメラを使う
    ...(XR8.XrConfig ? { cameraConfig: { direction: XR8.XrConfig.camera().FRONT } } : {}),
  });
}

/** エンジンを停止しパイプラインを破棄する（エディタプレビューの終了用） */
export function stop() {
  teardownPhotoCapture();
  teardownSplash();
  teardownLegalFooter();
  teardownFullWindowCanvas();
  const XR8 = window.XR8;
  if (!XR8) return;
  XR8.stop();
  XR8.clearCameraPipelineModules?.();
}
