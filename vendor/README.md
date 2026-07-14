# vendor/ — 外部ライブラリの配置場所

## 同梱済み

- `three.module.js` — three.js (MIT License, https://github.com/mrdoob/three.js)
- `xr.js` ほか（`xr-slam.js` / `xr-face.js` / `resources/` / `LICENSE`）—
  8th Wall Engine (Niantic Spatial, Inc.)。書き出し元の `runtime/vendor/` に
  配置されていたエンジン一式を自動同梱しています。
- `xrextras.js` — 8th Wall XRExtras (MIT License, `XREXTRAS-LICENSE` 参照)。
  全画面canvas調整・ローディング画面・エラー表示を担当します。

## 8th Wall Engine のライセンスについて（重要）

- Distributed Engine Binary を同梱している場合、限定利用ライセンスが適用されます:
  https://8th.io/license-FAQ
- リバースエンジニアリング・改変・改変版の再配布は禁止されています。
- `LICENSE`（同梱）と ルートの `ATTRIBUTION.md` は削除しないでください（帰属表示義務）。
- エンジン自体やエンジンベースのツールキットの販売は許可されないため、
  本バンドルおよび生成元ツール（webAR_tool）は**内製利用の範囲**で使用してください。
  外部への販売・SaaS提供を行う場合は事前に法務確認が必要です。

## ホスティング時の注意

- カメラアクセスのため **HTTPS** でホストしてください（file:// では動作しません）。
