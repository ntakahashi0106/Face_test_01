/**
 * 起動ブートストラップ（webAR_toolが生成）。
 * ARモード本体は mode-runtime.js を参照。
 */
import { start } from './mode-runtime.js';

start().catch((err) => {
  console.error('[webar-tool] ランタイムの起動に失敗しました:', err);
  const el = document.getElementById('runtime-error');
  if (el) {
    el.hidden = false;
    el.textContent = '起動エラー: ' + (err instanceof Error ? err.message : String(err));
  }
});
