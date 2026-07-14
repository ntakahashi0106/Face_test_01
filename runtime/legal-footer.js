/**
 * legal-footer: AR体験のライセンス・利用規約表示（8th Wall Engineライセンス準拠）。
 *
 * - 8th Wall Engine（Niantic Spatial, Inc.）のXR Engine License Agreement 第1.3.2項は、
 *   「エンジンの機能を利用するあらゆる成果物」に対し、作成者表示・著作権表示・
 *   本契約への参照・保証免責の通知を保持し、契約書の本文またはURIへのリンクを
 *   含めることを義務付けている。開発者しか見ないZIP内のATTRIBUTION.mdだけでは
 *   エンドユーザー向けの表示として不十分なため、AR体験の画面自体に表示する
 * - 画面隅に小さなリンクを常時表示し、タップでAbout/ライセンスオーバーレイを開く。
 *   この表示自体は必須のため無効化はできない（ATTRIBUTION.mdと同様の扱い）
 * - 利用規約・プライバシーポリシーは doc.ar.legalFooter に自社URLが設定されている
 *   場合のみ任意でリンクを追加する（本ツールが文面を生成することはない）
 * - three.js にも ARエンジン(XR8.*) にも依存しない、純粋なDOM操作
 * - 書き出しバンドルでは runtime/legal-footer.js として配置される。
 *   エディタ内プレビューも同じコードを実行する（単一ソース原則）
 */

const FOOTER_ID = 'webar-tool-legal-footer';
/** 8th Wallが案内する契約・ライセンスFAQの正規URL（README/ATTRIBUTION.mdと同一） */
const LICENSE_URL = 'https://8th.io/license-FAQ';

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function buildOverlayHtml(doc) {
  const legal = doc.ar?.legalFooter ?? { termsUrl: '', privacyUrl: '' };
  const hasLottie = (doc.mediaAssets || []).some((a) => a.kind === 'lottie');
  const sceneName = doc.name || 'WebAR Experience';

  const links = [];
  if (legal.termsUrl) {
    links.push(
      `<a href="${escapeAttr(legal.termsUrl)}" target="_blank" rel="noopener">利用規約</a>`,
    );
  }
  if (legal.privacyUrl) {
    links.push(
      `<a href="${escapeAttr(legal.privacyUrl)}" target="_blank" rel="noopener">` +
        `プライバシーポリシー</a>`,
    );
  }

  return `
    <div class="wat-legal-box">
      <button type="button" class="wat-legal-close" aria-label="閉じる">&times;</button>
      <h2>${escapeHtml(sceneName)}</h2>
      ${links.length ? `<p class="wat-legal-links">${links.join(' ・ ')}</p>` : ''}
      <h3>使用エンジン</h3>
      <p>
        Powered by <strong>8th Wall Engine</strong><br />
        Copyright &copy; Niantic Spatial, Inc. All rights reserved.<br />
        Licensed under the Niantic Spatial XR Engine License Agreement.<br />
        The Software is provided "AS IS" without warranties of any kind.<br />
        <a href="${LICENSE_URL}" target="_blank" rel="noopener">${LICENSE_URL}</a>
      </p>
      <h3>オープンソースライブラリ</h3>
      <p>
        three.js &mdash; MIT License &mdash; &copy; three.js authors<br />
        8th Wall XRExtras &mdash; MIT License &mdash; &copy; Niantic Spatial, Inc.<br />
        ${hasLottie ? 'lottie-web &mdash; MIT License &mdash; &copy; Airbnb, Inc.<br />' : ''}
      </p>
      <p class="wat-legal-credit">Made with webAR_tool</p>
    </div>
  `;
}

const STYLE = `
  .wat-legal-box {
    max-width: 420px; margin: 0 auto; background: #1b1b1f; color: #eee;
    border-radius: 10px; padding: 20px; position: relative;
    font-size: 13px; line-height: 1.7;
  }
  .wat-legal-box h2 { font-size: 16px; margin: 0 0 8px; padding-right: 24px; }
  .wat-legal-box h3 {
    font-size: 12px; color: #aaa; margin: 16px 0 4px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .wat-legal-box p { margin: 4px 0; }
  .wat-legal-box a { color: #7fa8ff; word-break: break-all; }
  .wat-legal-links { font-size: 12px; }
  .wat-legal-credit { margin-top: 16px; font-size: 11px; color: #777; }
  .wat-legal-close {
    position: absolute; top: 12px; right: 12px; width: 28px; height: 28px;
    border-radius: 50%; border: none; background: rgba(255,255,255,0.1);
    color: #fff; font-size: 16px; cursor: pointer; line-height: 1;
  }
`;

/**
 * 法的表示フッターをセットアップする（常時表示・無効化不可）。
 * @param {object} doc SceneDocument
 */
export function setupLegalFooter(doc) {
  teardownLegalFooter();

  const root = document.createElement('div');
  root.id = FOOTER_ID;

  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const link = document.createElement('button');
  link.type = 'button';
  link.textContent = 'ⓘ';
  link.setAttribute('aria-label', 'ライセンス・利用規約');
  link.style.cssText =
    'position:fixed;right:8px;bottom:8px;z-index:120;' +
    'width:22px;height:22px;border-radius:50%;border:none;' +
    'background:rgba(0,0,0,0.35);color:rgba(255,255,255,0.85);' +
    'font-size:13px;line-height:22px;padding:0;cursor:pointer;';
  root.appendChild(link);

  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:130;display:none;overflow-y:auto;' +
    'background:rgba(0,0,0,0.75);padding:24px 16px;' +
    "font-family:'Segoe UI','Hiragino Sans','Noto Sans JP',sans-serif;";
  overlay.innerHTML = buildOverlayHtml(doc);
  root.appendChild(overlay);

  link.addEventListener('click', () => {
    overlay.style.display = 'block';
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
  overlay.querySelector('.wat-legal-close')?.addEventListener('click', () => {
    overlay.style.display = 'none';
  });

  document.body.appendChild(root);
}

/** 法的表示フッターを取り除く（エディタプレビューの終了・再起動用） */
export function teardownLegalFooter() {
  document.getElementById(FOOTER_ID)?.remove();
}
