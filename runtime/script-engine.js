/**
 * script-engine: スクリプトコンポーネント（Unityライクなプログラム制御）の実行環境。
 *
 * - SceneObject.components.script.source は「ハンドラを持つオブジェクトを return する
 *   JavaScript」として解釈する:
 *     return { onStart(ctx){}, onUpdate(ctx){}, onTap(ctx){} };
 * - ctx API: { object, THREE, time, delta, find(name), scene, camera }
 *     object: 自オブジェクトの THREE.Object3D
 *     find(name): シーン内オブジェクトを名前で取得（見つからなければ null）
 *     time: 開始からの経過秒 / delta: 前フレームからの秒
 * - 実行はプレビューと書き出したARのみ（エディタのビューポートでは実行しない）。
 *   本ツールは内製利用のためサンドボックスは設けない（シーン制作者=利用者）。
 * - ARエンジン(XR8.*)には依存しない。書き出しバンドルでは runtime/script-engine.js
 *   として配置される。
 */
import * as THREE from 'three';

/**
 * シーン内のスクリプトをコンパイルして実行環境を作る。
 * 各ARモードのランタイムが、パイプラインの onStart（scene/camera確定後）に呼ぶ。
 *
 * @param {object} doc SceneDocument
 * @param {Map<string, THREE.Object3D>} byId buildSceneNodes の結果（オブジェクトid → ノード）
 * @param {{ scene: object, camera: object, canvas: HTMLCanvasElement }} env
 * @returns {{ start(): void, update(): void, dispose(): void }}
 */
export function createScriptRuntime(doc, byId, { scene, camera, canvas }) {
  // 名前 → ノード（ctx.find用。同名がある場合は先勝ち）
  const byName = new Map();
  for (const obj of doc.objects || []) {
    const node = byId.get(obj.id);
    if (node && !byName.has(obj.name)) byName.set(obj.name, node);
  }
  const find = (name) => byName.get(name) ?? null;

  const clock = new THREE.Clock();
  let time = 0;

  /** @type {Array<{name: string, node: object, handlers: object, errored: Set<string>}>} */
  const instances = [];
  for (const obj of doc.objects || []) {
    const script = obj.components?.script;
    if (!script?.enabled || !script.source?.trim()) continue;
    const node = byId.get(obj.id);
    if (!node) continue;
    try {
      // ソースをファクトリとして実行し、ハンドラ群を得る
      const factory = new Function(`"use strict";\n${script.source}`);
      const handlers = factory() || {};
      instances.push({ name: obj.name, node, handlers, errored: new Set() });
    } catch (err) {
      console.error(`[webar-tool] スクリプトのコンパイルに失敗しました（${obj.name}）:`, err);
    }
  }

  /** ハンドラ呼び出し（エラーはオブジェクト単位で1回だけ報告し、実行は継続する） */
  function invoke(instance, handlerName, ctx) {
    const handler = instance.handlers[handlerName];
    if (typeof handler !== 'function') return;
    try {
      handler(ctx);
    } catch (err) {
      if (!instance.errored.has(handlerName)) {
        instance.errored.add(handlerName);
        console.error(
          `[webar-tool] スクリプトエラー（${instance.name} / ${handlerName}）:`,
          err,
        );
      }
    }
  }

  const baseCtx = (instance, delta) => ({
    object: instance.node,
    THREE,
    time,
    delta,
    find,
    scene,
    camera,
  });

  // --- タップ処理: canvas上のクリック位置からレイキャストして onTap を呼ぶ ---
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const tappables = instances.filter((i) => typeof i.handlers.onTap === 'function');

  function onCanvasClick(e) {
    if (tappables.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(
      tappables.map((i) => i.node),
      true,
    );
    if (hits.length === 0) return;
    // 最前面のヒットが属するインスタンスを探す（ノードの子孫か祖先を辿って判定）
    let hitNode = hits[0].object;
    while (hitNode) {
      const instance = tappables.find((i) => i.node === hitNode);
      if (instance) {
        invoke(instance, 'onTap', baseCtx(instance, 0));
        return;
      }
      hitNode = hitNode.parent;
    }
  }
  canvas.addEventListener('click', onCanvasClick);

  return {
    start() {
      for (const instance of instances) {
        invoke(instance, 'onStart', baseCtx(instance, 0));
      }
    },
    update() {
      const delta = clock.getDelta();
      time += delta;
      for (const instance of instances) {
        invoke(instance, 'onUpdate', baseCtx(instance, delta));
      }
    },
    dispose() {
      canvas.removeEventListener('click', onCanvasClick);
    },
  };
}

/**
 * エディタのInspectorがスクリプトの構文を事前チェックするためのヘルパー。
 * @returns {string | null} エラーメッセージ（問題なければ null）
 */
export function validateScriptSource(source) {
  try {
    const factory = new Function(`"use strict";\n${source}`);
    const handlers = factory();
    if (handlers === undefined || handlers === null) {
      return 'ハンドラが return されていません（return { onUpdate(ctx) {...} } の形式で記述してください）';
    }
    if (typeof handlers !== 'object') {
      return 'return の値がオブジェクトではありません';
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
