# 作业文档源文件

成品位于根目录的 `output/pdf/音乐单词实验作业要求.pdf`。本目录保留排版源文件和对应版本的实际操作截图，便于随界面更新。

生成文档需要 Python、ReportLab 和 Pillow；当前版使用 Windows 自带的宋体、黑体与 Consolas。安装文档依赖后，在项目根目录运行：

```sh
python -m pip install -r docs/assignment/requirements.txt
python docs/assignment/build_assignment.py
```

截图为 POP909 已有标注和界面操作示例，其中的参数、匹配结果与作品仅用于说明操作，不作为评分标准。
