# 数据目录

本仓库包含独立运行 ActiveBasis 工作台、重新导出网页标注和执行命令行训练所需的数据。

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `POP909-Dataset/POP909/` | 909 首主曲目、其他编配版本、节拍/和弦/调性文本及 `index.xlsx` | 曲目列表、MIDI 导入、量化和训练 |
| `labeled data/T_dict/` | 154 个原始 pickle 文件，包含原目录中的 `c` 后缀版本 | 命令行标注评估、导出音形字典标注 |
| `labeled data/Labeled Songs/` | 67 个原始 CSV 文件 | 导出音符表标注 |
| `web/public/annotations/` | 28 首曲目、80 条音轨的 JSON 与索引 | 网页标注叠加 |
| `web/public/music-preview/` | MIDI 播放与乐谱预览资源、八款采样音色及许可证 | 本地及离线试听 |
| `results/simple_sparse_code/1/`、`2/` | 两份自包含回放及各自的参数、指标 | 启动后的示例记录、离线回放 |

POP909 数据文件从本地 MusicWord 使用的数据目录原样复制，来源为 [Music X Lab 的 POP909-Dataset](https://github.com/music-x-lab/POP909-Dataset)。上游的说明和许可证分别保存在 `POP909-Dataset/README.md` 与 `POP909-Dataset/LICENSE`，论文引用信息见上游说明。

原始标注从本地 Texton-new 的 `labeled data` 原样复制；复制时核对其 221 个文件与原命令行实验使用的标注目录逐字节一致。原始 pickle 和 CSV 是独立来源，保留各自的覆盖范围；网页导出器只处理 `<曲目编号>-<音轨编号>` 命名的文件，保留 `c` 后缀原文件但不将其重复计入网页音轨。

`data-manifest.sha256` 记录上述数据、预览资源、上游说明和两份回放的 SHA-256，用于核对克隆或传输后的文件内容。新实验产生的额外结果不在这份随仓库发布的数据清单中。

默认命令使用仓库内的数据，不依赖原电脑的绝对路径。已有回放旁的 `Parameters.csv` 保留历史实验路径以记录来源；无需修改这些历史记录即可查看回放或重新训练。
