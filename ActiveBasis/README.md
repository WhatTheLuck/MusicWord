# ActiveBasis

从 POP909 的 MIDI 音轨提取加权钢琴卷帘，学习由音符基元组成的重复音形。训练流程保留随机字典初始化、变体匹配、残差更新、片段合并和字典重学习。

- `SimpleSparseCode.py` 负责命令行、训练轮次和结果输出。
- `active_basis.py` 实现音形表示、编码和字典更新。训练参数集中在 `LearningConfig`。
- `song_data.py` 读取 MIDI 和已有标注，计算每轮指标。

## 运行

在此目录使用 Python 3.11。仓库已包含完整的 POP909 数据、原始标注、网页标注和示例回放；数据目录与来源见 [DATA.md](DATA.md)。克隆后无需从其他本地项目复制数据。

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe SimpleSparseCode.py `
  --pop909-dir "POP909-Dataset/POP909" `
  --label-dir "labeled data" `
  --song-ids 2 --rounds 2
```

`--pop909-dir` 和 `--label-dir` 默认就是上述仓库内目录，也可省略。`--pop909-dir` 指向包含 `002/002.mid` 的目录。`--label-dir` 指向包含 `T_dict/` 的目录，只加载来源可信的已有标注 pickle。默认 MIDI 音轨索引为 1，对应 `T_dict/2-0.pkl`。以 `--track-number 2` 运行时读取 `T_dict/2-1.pkl`。`--help` 可查看参数。

每次运行在 `results/simple_sparse_code/` 下创建编号目录，写出 `Parameters.csv` 和 `Metrics.csv`。 `--plot-metrics` 在训练结束后显示曲线。此版本使用 SciPy 在 CPU 上计算相关性，并让标注与填充后的卷帘共享坐标。与旧脚本比较时应重新计算实验结果。

## 网页回放

在上面的训练命令末尾加上 `--visualize`。训练完成后，直接用浏览器打开编号目录中的 `Playback.html`。页面离线运行，可以在记录中切换曲目和轮次。候选生成、编码与重学习支持拖动进度、逐帧查看和变速播放。在量化、响应、编码和迭代对比中，可拖动全曲缩略图浏览时间段。

回放保留候选接受与淘汰、变体响应、原谱与编码残差、响应更新前后、片段逆变换、密度图合并、逐音符生成和指标曲线。初始全曲响应图按时间分组取最大值，逐步编码处显示每次匹配对应的局部时间列。启用回放时也记录最后一轮编码后的字典重学习。回放越长，HTML 文件越大。

## 本地交互工作台

总过程、各训练步骤、匹配样例和指标评估均附有带行号的伪代码。代码中的输入框与训练参数双向同步，修改后自动重算；「参数滑块与说明」可展开查看原有控件和解释。离线导出的伪代码显示记录参数，输入框为只读状态。

「乐谱量化」会在量化钢琴卷帘和全曲缩略图上叠加当前 POP909 曲目和音轨的人工标注。可切换音形字典或音符表、筛选类别，也可关闭叠加。Texton 数据共收录 28 首曲目、80 条标注音轨，构建版也包含这批标注。

更新数据时，使用以下命令重新导出。输入目录应包含 `T_dict` 和 `Labeled Songs`，原始 `POP909` 默认位于其同级目录，也可通过 `--midi-root` 指定。请只导入可信来源的 pickle。

```powershell
.\.venv\Scripts\python.exe export_annotations.py "labeled data" --midi-root "POP909-Dataset/POP909"
```

安装上述 Python 依赖，并使用 Node.js 22.12 或更新版本，在项目根目录运行。

```powershell
npm ci
npm run dev
```

打开终端显示的本地地址，默认是 `http://127.0.0.1:5173`。选择 POP909 曲名和音轨，或导入本地 MIDI。调节参数后，量化预览、相似度小样例及训练结果会按各自使用的参数自动重算。连续调节时，以最后一组有效参数为准。计算在本机完成，顶部「大轮次」横条可切换迭代结果。交互训练使用当前音轨，显示重构均方根误差。需要使用标注评估多首曲目时，运行上面的命令行流程。

「相似度量」同时展示七个测试样例。每组显示一个单词、一段乐谱及其最优音高倍率的匹配响应图。各图共用色阶，白框标记峰值，旁边列出峰值分数和单词左下角相对乐谱原点的音高与时间坐标。可在此处调节「每个基元的响应惩罚」，七组样例随之重算。

在「单词响应」中，点击左侧单词即可展开一行原型和变体，选择变体查看它在原谱上的响应。「重学习字典」逐个单词回放初始密度、每次添加基元的过程和学习结果，进度条显示当前单词与构建步骤。

工作台从项目内的 `POP909-Dataset/POP909` 或同级实验目录 `Lab/MidiParser/POP909` 查找曲目和 `index.xlsx`。也可以在启动前用 `ACTIVE_BASIS_POP909` 指定数据目录。Python 默认使用项目的 `.venv`，可通过 `ACTIVE_BASIS_PYTHON` 指定解释器。

工作台默认读取 `results/simple_sparse_code/` 中最近导出的 `Playback.html`。点击轮次编号可浏览已有轮次。点击顶部或「大轮次」窗口中轮次栏右端的「+」，可接着最后一轮重学习后的字典再训练一轮，并自动选中新追加的对照列。已有回放和网页发起的训练都可以逐轮继续，新增轮次保存在当前页面会话中。回放续训会计算重构误差和已有标注框的平均交并比，需要逐音符标注的指标显示为「—」。若回放保存在自定义目录，可在启动前指定文件。

```powershell
$env:ACTIVE_BASIS_PLAYBACK = "D:\experiments\1\Playback.html"
npm run dev
```

`npm run build` 将网页和已有回放打包到 `dist/`。运行 `npm run preview` 可在本机打开构建版并运行交互训练。静态托管和导出的 `Playback.html` 支持查看已有记录，曲目导入和重新计算需要本地工作台。
