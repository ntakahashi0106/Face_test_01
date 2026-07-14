/**
 * splash: スプラッシュ画面（起動画面）。
 *
 * - AR起動時にタイトル・サブタイトル・ロゴを表示し、エンジン/カメラの
 *   読み込み完了まで画面を覆う（ローディングの目隠しを兼ねる）
 * - startMode 'tap'  = AR準備完了後に「タップしてスタート」ボタンを表示し、タップで閉じる
 *   startMode 'auto' = AR準備完了後、最低表示時間を満たしたら自動でフェードアウト
 * - ARエンジン(XR8.*)にも three.js にも依存しない。
 *   書き出しバンドルでは runtime/splash.js として配置され、
 *   エディタ内プレビューも同じコードを実行する（単一ソース原則）
 */

const UI_ID = 'webar-tool-splash';
/** autoモードの最低表示時間（ロゴが一瞬で消えるのを防ぐ） */
const MIN_DISPLAY_MS = 1500;
const FADE_MS = 400;

/**
 * スプラッシュ画面を表示する。doc.ar.splash.enabled が false なら何もしない。
 * 各ARモードのランタイムが start() の冒頭で呼び、AR準備完了
 * （パイプラインの onStart）で ready() を呼ぶ。
 *
 * @param {object} doc SceneDocument
 * @param {Map<string, {asset: object, data: ArrayBuffer}>} assetLibrary loadAssetLibraryの結果
 * @returns {{ ready(): void, dispose(): void }}
 */
/** スプラッシュUIを取り除く（エディタプレビューの終了用） */
export function teardownSplash() {
  document.getElementById(UI_ID)?.remove();
}

export function createSplash(doc, assetLibrary) {
  const settings = doc.ar?.splash;
  if (!settings?.enabled) {
    return { ready() {}, dispose() {} };
  }
  if (settings.mode === 'custom') {
    return createCustomSplash(settings);
  }

  document.getElementById(UI_ID)?.remove();
  const shownAt = Date.now();

  const root = document.createElement('div');
  root.id = UI_ID;
  root.style.cssText =
    `position:fixed;inset:0;z-index:150;display:flex;flex-direction:column;` +
    `align-items:center;justify-content:center;gap:16px;padding:32px;text-align:center;` +
    `background:${settings.backgroundColor};color:${settings.textColor};` +
    `font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif;` +
    `transition:opacity ${FADE_MS}ms;`;

  // ロゴ（任意）
  const logoEntry = settings.logoAssetId ? assetLibrary.get(settings.logoAssetId) : undefined;
  if (logoEntry) {
    const url = URL.createObjectURL(new Blob([logoEntry.data], { type: logoEntry.asset.mime }));
    const logo = document.createElement('img');
    logo.src = url;
    logo.alt = '';
    logo.style.cssText = 'max-width:45%;max-height:30vh;object-fit:contain;';
    root.appendChild(logo);
  }

  if (settings.title) {
    const title = document.createElement('div');
    title.textContent = settings.title;
    title.style.cssText = 'font-size:26px;font-weight:700;letter-spacing:0.04em;';
    root.appendChild(title);
  }

  if (settings.subtitle) {
    const subtitle = document.createElement('div');
    subtitle.textContent = settings.subtitle;
    subtitle.style.cssText = 'font-size:14px;opacity:0.75;';
    root.appendChild(subtitle);
  }

  // ステータス領域: 読み込み中スピナー → （tapモードでは）スタートボタン
  const status = document.createElement('div');
  status.style.cssText = 'margin-top:12px;min-height:52px;display:flex;align-items:center;justify-content:center;';
  const spinner = document.createElement('div');
  spinner.style.cssText =
    `width:28px;height:28px;border-radius:50%;` +
    `border:3px solid ${settings.textColor}33;border-top-color:${settings.textColor};` +
    `animation:webar-splash-spin 0.9s linear infinite;`;
  const style = document.createElement('style');
  style.textContent = '@keyframes webar-splash-spin { to { transform: rotate(360deg); } }';
  root.appendChild(style);
  status.appendChild(spinner);
  root.appendChild(status);

  document.body.appendChild(root);

  let hidden = false;
  function hide() {
    if (hidden) return;
    hidden = true;
    root.style.opacity = '0';
    setTimeout(() => root.remove(), FADE_MS);
  }

  return {
    /** AR準備完了（パイプラインのonStart）で呼ぶ */
    ready() {
      if (hidden) return;
      if (settings.startMode === 'auto') {
        const remaining = Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt));
        setTimeout(hide, remaining);
        return;
      }
      // tapモード: スピナーをスタートボタンに差し替える
      spinner.remove();
      const startButton = document.createElement('button');
      startButton.type = 'button';
      startButton.textContent = 'タップしてスタート';
      startButton.style.cssText =
        `padding:12px 36px;border-radius:24px;border:2px solid ${settings.textColor};` +
        `background:transparent;color:${settings.textColor};font-size:15px;font-weight:600;` +
        `cursor:pointer;letter-spacing:0.06em;`;
      startButton.addEventListener('click', hide);
      status.appendChild(startButton);
    },
    /** エディタプレビューの終了・再起動用 */
    dispose() {
      hidden = true;
      root.remove();
    },
  };
}

/**
 * カスタムモード: ユーザー記述のHTML/CSS/JSでスプラッシュを描画する。
 *
 * - HTML/CSSは Shadow DOM に隔離して描画（ARページ本体のスタイルと干渉しない）
 * - `data-splash-start` 属性を付けた要素のクリックで自動的に閉じる
 * - JSは new Function でコンパイルし ctx = { root, close, onReady(cb) } を渡す。
 *   onReady のコールバックはAR準備完了（パイプラインonStart）で呼ばれる
 * - `data-splash-start` 要素が存在しない場合は、閉じ忘れでARが始まらない事故を
 *   防ぐため、AR準備完了後に最低表示時間を満たして自動クローズする
 */
function createCustomSplash(settings) {
  document.getElementById(UI_ID)?.remove();
  const shownAt = Date.now();

  const root = document.createElement('div');
  root.id = UI_ID;
  root.style.cssText =
    `position:fixed;inset:0;z-index:150;transition:opacity ${FADE_MS}ms;`;
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${settings.customCss || ''}</style>${settings.customHtml || ''}`;
  document.body.appendChild(root);

  let hidden = false;
  function close() {
    if (hidden) return;
    hidden = true;
    root.style.opacity = '0';
    setTimeout(() => root.remove(), FADE_MS);
  }

  // data-splash-start 要素のクリックで閉じる（複数可）
  const startElements = shadow.querySelectorAll('[data-splash-start]');
  for (const el of startElements) {
    el.addEventListener('click', close);
  }

  // AR準備完了コールバック
  let isReady = false;
  const readyCallbacks = [];
  function onReady(callback) {
    if (typeof callback !== 'function') return;
    if (isReady) callback();
    else readyCallbacks.push(callback);
  }

  // ユーザーJSの実行（エラーでもスプラッシュ自体は動作継続）
  if (settings.customJs?.trim()) {
    try {
      const fn = new Function('ctx', `"use strict";\n${settings.customJs}`);
      fn({ root: shadow, close, onReady });
    } catch (err) {
      console.error('[webar-tool] スプラッシュのカスタムJSでエラーが発生しました:', err);
    }
  }

  return {
    ready() {
      isReady = true;
      for (const callback of readyCallbacks.splice(0)) {
        try {
          callback();
        } catch (err) {
          console.error('[webar-tool] スプラッシュのonReadyコールバックでエラー:', err);
        }
      }
      // 閉じる手段が無い場合のフォールバック: 自動クローズ
      if (startElements.length === 0) {
        const remaining = Math.max(0, MIN_DISPLAY_MS - (Date.now() - shownAt));
        setTimeout(close, remaining);
      }
    },
    dispose() {
      hidden = true;
      root.remove();
    },
  };
}
