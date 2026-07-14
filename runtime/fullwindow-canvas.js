/**
 * fullwindow-canvas: 描画canvasを常に画面全体に合わせるフォールバック。
 *
 * - 8th Wall公式の XRExtras.FullWindowCanvas と同じ役割の最小実装。
 *   通常は vendor/xrextras.js が読み込まれて XRExtras 側が処理するため、
 *   本モジュールは **XRExtrasが無い場合にのみ** ランタイムから使われる
 * - canvasの描画バッファ（width/height属性）が表示サイズと一致していないと、
 *   カメラ映像が画面の一部（左上）に小さく描かれる。エンジンはcanvasサイズの
 *   変化を onCanvasSizeChange で検知して表示を再構成するため、
 *   バッファサイズをウィンドウサイズに同期し続ければ全画面表示になる
 * - three.js にも ARエンジン(XR8.*) にも依存しない、純粋なDOM操作
 */

let state = null;

/**
 * canvasを画面全体に合わせ、リサイズ・画面回転へ追従させる。
 * @param {HTMLCanvasElement} canvas
 */
export function setupFullWindowCanvas(canvas) {
  teardownFullWindowCanvas();

  const resize = () => {
    // モバイルGPU負荷を抑えるためデバイスピクセル比は2を上限にする
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
  };

  // iOSは回転直後にinnerWidth/Heightが確定しないことがあるため少し遅らせて再計測する
  const onOrientation = () => {
    resize();
    setTimeout(resize, 300);
  };

  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', onOrientation);
  state = { resize, onOrientation };
}

/** リサイズ追従を解除する（エディタプレビューの終了・再起動用） */
export function teardownFullWindowCanvas() {
  if (!state) return;
  window.removeEventListener('resize', state.resize);
  window.removeEventListener('orientationchange', state.onOrientation);
  state = null;
}
