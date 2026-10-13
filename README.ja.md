# Obsidian Plugin Kit

[English](./README.md)

Obsidianプラグインを立ち上げるための非視覚基盤である。現在は共通のRolldown設定、TypeScript基準、配布プリミティブを提供する。

## パッケージ境界

- `./rolldown`: Obsidianをexternalに保ち、単一CommonJS成果物を生成する設定
- `./tsconfig`: React/TypeScriptプラグイン向けの厳格な型検査基準
- `./deploy`: manifest、versions、Release成果物、既存Vault rootを検証し、`plugins/<plugin-id>`以外への誤配布を拒否する。複数Vaultへの配布とcommunity plugin有効化を一つのトランザクションとして扱い、途中で失敗した場合は旧状態へ戻す。配布先の新規初期化には明示的な指定が必要

ソースRepositoryは公開するが、npm公開は`private: true`で意図的に無効化する。利用側はタグ付きGit revisionを指定し、共有処理の内容と再現性を固定する。

## 昇格ルール

- 2つ以上のプラグインで実際に重複している
- Obsidian固有の制約であり、各プロダクトの世界観に依存しない
- APIを独立してテストできる
- 片方の都合だけで破壊的変更されない

UIコンポーネント、色、余白、角丸、文言は共有しない。全条件を満たした共通処理だけを追加する。

## 昇格フロー

1. 各プラグイン内で問題を解決する
2. 2製品目でも同じ問題が実在することを確認する
3. プロダクト固有の語彙と見た目を除く
4. 独立テストと後方互換の契約を追加する
5. このpackageへ移し、タグ付きreleaseを利用する

「将来使いそう」は昇格理由にしない。共有による変更連鎖が、重複保守のコストを下回る場合だけ昇格する。
