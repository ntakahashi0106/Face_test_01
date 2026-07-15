/**
 * error-display: ARパイプラインの例外を画面に表示するデバッグ支援モジュール。
 *
 * XRExtras.RuntimeError の「Oops, something went wrong!」画面は原因を表示しない
 * ため、実機（スマホ）ではエラー内容が分からず調査できない。本モジュールは
 * onException で受けた実際のエラーメッセージを index.html の #runtime-error
 * オーバーレイ（z-index はXRExtrasの画面より上）に表示する。
 * エディタ内プレビューには #runtime-error が無いため何もしない（コンソールのみ）。
 */
export function createErrorDetailModule() {
  return {
    name: 'webar-tool-error-detail',
    onException: (error) => {
      console.error('[webar-tool] ARパイプラインでエラーが発生しました:', error);
      // AlmostThere（非対応ブラウザ/デバイスの案内画面）が対応した場合は、
      // 生のエラー表示よりそちらのUI（QRコード・「ブラウザで開く」案内）を優先する
      setTimeout(() => {
        if (document.getElementById('almostthereContainer')) return;
        const el = document.getElementById('runtime-error');
        if (!el) return;
        el.hidden = false;
        const message = error instanceof Error ? error.message : String(error);
        el.textContent = `ARエラー: ${message}`;
      }, 0);
    },
  };
}
