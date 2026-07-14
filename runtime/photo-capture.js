/**
 * photo-capture: フォトフレーム（撮影）機能。
 *
 * - AR画面にシャッターボタンと（指定時は）フレーム画像のオーバーレイを表示する
 * - 撮影は XR8.CanvasScreenshot（Distributed Engine Binary / OSS版共通API）を使い、
 *   カメラ映像 + ARコンテンツ + フレーム画像を合成した写真を生成する
 * - スマホでは Web Share API（シェアシート）、非対応環境ではダウンロードで保存する
 * - XR8.* への依存はランタイム層（このファイル）に閉じ込める。three.js には依存しない
 * - 書き出しバンドルでは runtime/photo-capture.js として配置される。
 *   エディタ内プレビューも同じコードを実行する（単一ソース原則）
 */

const UI_ID = 'webar-tool-photo-ui';

/** cover相当（画面全体を覆い、はみ出しは切る）でフレームを描画する */
function drawCover(ctx, img, width, height) {
  const scale = Math.max(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('フレーム画像の読み込みに失敗しました'));
    img.src = url;
  });
}

/**
 * フォトフレームUIをセットアップする。
 * doc.ar.photoFrame.enabled が false の場合は何もしない。
 *
 * @param {object} doc SceneDocument
 * @param {Map<string, {asset: object, data: ArrayBuffer}>} assetLibrary loadAssetLibraryの結果
 * @param {{ canvas?: HTMLCanvasElement }} [options] 撮影フォールバック用のARキャンバス
 * @returns {{ pipelineModules: object[] }} XR8.addCameraPipelineModules に足すモジュール
 */
export function setupPhotoCapture(doc, assetLibrary, options = {}) {
  const settings = doc.ar?.photoFrame;
  if (!settings?.enabled) return { pipelineModules: [] };

  teardownPhotoCapture();
  const XR8 = window.XR8;

  // --- フレーム画像（任意） ---
  let frameUrl = null;
  const frameEntry = settings.frameAssetId ? assetLibrary.get(settings.frameAssetId) : undefined;
  if (frameEntry) {
    frameUrl = URL.createObjectURL(
      new Blob([frameEntry.data], { type: frameEntry.asset.mime }),
    );
  }

  // --- UI構築（スタイルはインラインで自己完結させる） ---
  const root = document.createElement('div');
  root.id = UI_ID;

  if (frameUrl) {
    const frame = document.createElement('img');
    frame.src = frameUrl;
    frame.alt = '';
    frame.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;' +
      'pointer-events:none;z-index:105;';
    root.appendChild(frame);
  }

  const shutter = document.createElement('button');
  shutter.type = 'button';
  shutter.title = '撮影する';
  shutter.style.cssText =
    'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);' +
    'width:64px;height:64px;border-radius:50%;border:4px solid #fff;' +
    'background:rgba(255,255,255,0.35);cursor:pointer;z-index:106;padding:0;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.4);';
  root.appendChild(shutter);

  // 撮影時のフラッシュ演出
  const flash = document.createElement('div');
  flash.style.cssText =
    'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;' +
    'transition:opacity 0.25s;z-index:107;';
  root.appendChild(flash);

  document.body.appendChild(root);

  async function capture() {
    // 1. AR画面（カメラ映像+3D）を取得
    let shotUrl = null;
    if (XR8?.CanvasScreenshot?.takeScreenshot) {
      const base64 = await XR8.CanvasScreenshot.takeScreenshot();
      shotUrl = `data:image/jpeg;base64,${base64}`;
    } else if (options.canvas) {
      // エンジンAPIが無い場合のフォールバック（モック検証・非対応環境）
      shotUrl = options.canvas.toDataURL('image/jpeg', 0.92);
    }
    if (!shotUrl) throw new Error('撮影APIが利用できません');
    const shot = await loadImage(shotUrl);

    // 2. フレームを合成
    const canvas = document.createElement('canvas');
    canvas.width = shot.naturalWidth;
    canvas.height = shot.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(shot, 0, 0);
    if (frameUrl) {
      drawCover(ctx, await loadImage(frameUrl), canvas.width, canvas.height);
    }

    // 3. 保存/シェア
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    const file = new File([blob], `webar-photo-${Date.now()}.jpg`, { type: 'image/jpeg' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return; // ユーザーがキャンセル
        // シェア失敗時はダウンロードにフォールバック
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  }

  shutter.addEventListener('click', async () => {
    shutter.disabled = true;
    flash.style.opacity = '0.9';
    setTimeout(() => {
      flash.style.opacity = '0';
    }, 120);
    try {
      await capture();
    } catch (err) {
      console.error('[webar-tool] 撮影に失敗しました:', err);
    } finally {
      shutter.disabled = false;
    }
  });

  // CanvasScreenshotのパイプラインモジュール（撮影APIの前提。無ければ空）
  const pipelineModules = [];
  if (XR8?.CanvasScreenshot?.pipelineModule) {
    pipelineModules.push(XR8.CanvasScreenshot.pipelineModule());
  }
  return { pipelineModules };
}

/** フォトフレームUIを取り除く（エディタプレビューの終了・再起動用） */
export function teardownPhotoCapture() {
  document.getElementById(UI_ID)?.remove();
}
