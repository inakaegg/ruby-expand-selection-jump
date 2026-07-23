# Ruby Expand Selection & Jump

[![CI](https://github.com/inakaegg/ruby-expand-selection-jump/actions/workflows/ci.yml/badge.svg)](https://github.com/inakaegg/ruby-expand-selection-jump/actions/workflows/ci.yml)

Tree-sitter で Ruby の構文を解析し、選択範囲の拡張 / 縮小と `def`〜`end` のような対応キーワード間ジャンプを提供する VS Code 拡張です。

## 主な機能

- `do/def/if … end`、`class/module` などの対応キーワードへ一発ジャンプ。
- `else/elsif/when/rescue/ensure` の位置からも安全に末尾 `end` へ移動。
- Tree-sitter (`web-tree-sitter` + 同梱 `tree-sitter-ruby.wasm`) による AST 解析で、コメントや文字列内のキーワードを自動判別。
- Ruby の構文単位で選択範囲を段階的に拡張 (`Expand Selection`) / 逆順に縮小 (`Shrink Selection`)。拡張したステップを記憶しているため、縮小すると元のカーソル位置まで同じ階段を戻れます。

## 仕組み

- 各コマンドの実行時に、`web-tree-sitter` と同梱の Ruby 文法で現在の文書を解析します。RubyやTree-sitterを別途インストールする必要はありません。
- ブロック間ジャンプは構文ノードから対応する `do/def/if … end` を特定し、`()`、`[]`、`{}` では括弧の対応位置へジャンプします。
- 選択範囲は、より大きな構文ノードへ段階的に拡張します。履歴を文書とカーソルごとに保持するため、同じ経路を縮小で戻ることができ、複数カーソルも個別に動作します。

## コマンド一覧

| コマンド ID | 表示名 | 説明 | 既定キーバインド (mac / win&linux) |
| --- | --- | --- | --- |
| `rubyExpandSelection.jump` | Ruby: Jump to Matching do/def/if … end | 対応するブロック開始/終了/ミドルキーワードへジャンプ | ⌘⇧5 / Ctrl⇧5 |
| `rubyExpandSelection.expandSelection` | Ruby: Expand Selection (Tree-sitter) | Tree-sitter の範囲に沿って選択を1段階拡張 | ⇧⌥→ / Shift+Alt+Right |
| `rubyExpandSelection.shrinkSelection` | Ruby: Shrink Selection (Tree-sitter) | 直前の拡張ステップを逆順にたどって縮小 | ⇧⌥← / Shift+Alt+Left |

キーバインドは VS Code の「Keyboard Shortcuts」で自由に設定できます。

## 使い方
1. Ruby ファイル内でカーソルを移動。
2. 目的のコマンドを呼び出し（コマンドパレット or キーバインド）。
   - `Jump`：`do` / `def` / `if` / `end`、または `else` などのミドルキーワード上で実行。
   - `Expand Selection`：カーソル位置から Ruby の文法単位ごとに選択範囲を広げる。
   - `Shrink Selection`：直前の拡張履歴を逆順にたどり、段階的に狭めていく。

### 拡張 / 縮小の例

```ruby
total = orders.sum do |order|
  order.items.sum { |item| item.price_with_tax(rate) }
end
```

カーソルを `price_with_tax` の内部に置いて **Expand Selection** を繰り返すと、次のように Ruby の構文に沿って少しずつ広がります。

1. `price_with_tax`（メソッド名）
2. `item.price_with_tax`（レシーバ + メソッド）
3. `item.price_with_tax(rate)`（メソッド呼び出し全体）
4. `|item| item.price_with_tax(rate)`（ブロック本体）
5. `{ |item| item.price_with_tax(rate) }`（最内ブロック）
6. `order.items.sum { |item| item.price_with_tax(rate) }`（チェーンされたメソッド呼び出し）
7. `|order|\n  order.items.sum { |item| item.price_with_tax(rate) }`（外側ブロックの本体）
8. `do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend`（`do`〜`end` ブロック）
9. `orders.sum do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend`（メソッド呼び出し + ブロック）
10. `total = orders.sum do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend`（代入文全体）

そのまま **Shrink Selection** を呼ぶと、同じ階段を逆順にたどって元のカーソル位置へ戻れます。ブロックや配列、補間文字列なども Ruby 構文に沿ったステップで移動できます。

![Expand Selection のアニメーション](assets/expand_shrink.gif)

<details>
<summary>拡張のステップを視覚化する</summary>

`[ … ]` で囲んだ部分が現在の選択範囲です。

```text
1: order.items.sum { |item| item.[price_with_tax](rate) }
2: order.items.sum { |item| [item.price_with_tax](rate) }
3: order.items.sum { |item| [item.price_with_tax(rate)] }
4: order.items.sum { |item| [|item| item.price_with_tax(rate)] }
5: order.items.sum { [|item| item.price_with_tax(rate)] }
6: [order.items.sum { |item| item.price_with_tax(rate) }]
7: [|order|
     order.items.sum { |item| item.price_with_tax(rate) }]
8: [do |order|
     order.items.sum { |item| item.price_with_tax(rate) }
   end]
9: [orders.sum do |order|
     order.items.sum { |item| item.price_with_tax(rate) }
   end]
10: [total = orders.sum do |order|
      order.items.sum { |item| item.price_with_tax(rate) }
    end]
```

</details>

### ジャンプの例

![ジャンプのアニメーション](assets/jump.gif)

## インストール

### VS Code Marketplace

[VS Code MarketplaceのRuby Expand Selection & Jump](https://marketplace.visualstudio.com/items?itemName=inakaegg.ruby-expand-selection-jump)からインストールできます。または、VS CodeのQuick Open（`Ctrl+P` / `⌘P`）で次を実行します。

```text
ext install inakaegg.ruby-expand-selection-jump
```

## 動作条件

- VS Code 1.80.0以降
- VS CodeでRuby（language ID: `ruby`）として認識されている文書

## 開発者向けセットアップ

1. このフォルダを VS Code で開く
2. `npm install`
3. `npm run compile`
4. F5（Run Extension）で開いた別ウィンドウで Ruby ファイルを開き、コマンドを試す

`tree-sitter/` ディレクトリに runtime (`tree-sitter.wasm`) と Ruby 用 `tree-sitter-ruby.wasm` を同梱しているため、追加のビルド手順は不要です。

### テスト

`npm run test` を実行すると、拡張をビルドしたうえで、VS Codeを立ち上げずにTree-sitterベースの回帰テストが走ります。
ジャンプテストでは、`while` / `until` / `for` の各ブロック（`do` あり/なし）の対応キーワードが正しく往復できるかを `computeBlockTargetOffset` に直接入力して検証します。
拡張 / 縮小のゴールデンテストでは、上記の10段階の選択例に対してコマンドを実行し、縮小で同じ経路を元のカーソルまで逆順に戻れることを検証します。

GitHub Actionsでも、pushおよびpull requestごとに同じコマンドを実行します。

## 既知の制限

- ヒアドキュメント（`<<ID`）や `%q/%Q/%w` などの `%` 記法、正規表現リテラルは Tree-sitter 上では文字列リテラルとして扱われるため、内部の Ruby コードまでは解析しません。これらの内側に入った場合は外側の文字列単位で処理されます。
- 初回実行時は Tree-sitter の構文木構築が入るため、非常に大きなファイルではわずかに遅延する場合があります。
- AST 解析ベースのため、Tree-sitter の解析結果に依存します。Ruby の最新構文で問題に遭遇した場合は Issue でご報告ください。

不具合報告や改善案は Issue / PR でお気軽にお寄せください。
