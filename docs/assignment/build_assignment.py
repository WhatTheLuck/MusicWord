from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import black, HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/音乐单词实验作业要求.pdf'
SHOTS = Path(__file__).resolve().parent / 'images'
pdfmetrics.registerFont(TTFont('Song', 'C:/Windows/Fonts/simsun.ttc', subfontIndex=0))
pdfmetrics.registerFont(TTFont('Hei', 'C:/Windows/Fonts/simhei.ttf'))
pdfmetrics.registerFont(TTFont('Mono', 'C:/Windows/Fonts/consola.ttf'))
pdfmetrics.registerFontFamily('Song', normal='Song', bold='Hei', italic='Song', boldItalic='Hei')
W,H = A4
M = 52
CW = W-2*M
c = canvas.Canvas(str(OUT), pagesize=A4, pageCompression=1)
c.setTitle('音乐单词实验作业要求')
c.setAuthor('MusicWord')
styles = {
    'body': ParagraphStyle('body', fontName='Song', fontSize=11, leading=18, textColor=black, wordWrap='CJK'),
    'small': ParagraphStyle('small', fontName='Song', fontSize=9.5, leading=15, textColor=HexColor('#444444'), wordWrap='CJK'),
    'cell': ParagraphStyle('cell', fontName='Hei', fontSize=10, leading=16, alignment=1),
    'score': ParagraphStyle('score', fontName='Hei', fontSize=13, leading=20, alignment=1),
}
y = 0
page = 0
bottoms = []

def need(h):
    if y-h < 45:
        raise RuntimeError(f'Page {page} overflow: {y-h:.1f}')

def p(text, style='body', gap=7):
    global y
    flow = Paragraph(text, styles[style])
    _,h = flow.wrap(CW,1000)
    need(h)
    flow.drawOn(c,M,y-h)
    y -= h+gap

def section(title):
    global y
    need(29)
    y -= 7
    c.setFont('Hei',12)
    c.drawString(M,y-12,title)
    y -= 28

def end():
    bottoms.append(round(y,1))
    c.setFillColor(HexColor('#666666'))
    c.setFont('Song',9)
    c.drawCentredString(W/2,25,str(page))
    c.setFillColor(black)
    c.showPage()

def start(title, main=False):
    global y,page
    if page: end()
    page += 1
    c.bookmarkPage(f'p{page}')
    c.addOutlineEntry(title,f'p{page}')
    if not main:
        c.setFont('Song',9)
        c.setFillColor(HexColor('#555555'))
        c.drawString(M,H-36,'音乐单词实验作业 · 操作附录')
        c.setFillColor(black)
    c.setFont('Hei',20 if main else 16)
    if main:
        c.drawCentredString(W/2,H-61,title)
        y=H-83
    else:
        c.drawString(M,H-68,title)
        y=H-92

def step(n,text):
    p(f'{n}. {text}',gap=8)

def shot(filename,caption):
    global y
    path=SHOTS/filename
    iw,ih=Image.open(path).size
    h=CW*ih/iw
    need(h+25)
    c.drawImage(str(path),M,y-h,width=CW,height=h)
    y-=h+5
    p(caption,'small',gap=12)

def commands(lines):
    global y
    h=19*len(lines)+10
    need(h)
    c.setFont('Mono',10.5)
    for i,line in enumerate(lines):c.drawString(M+18,y-15-i*19,line)
    y-=h+5

def grading():
    global y
    names=['标注','ActiveBasis','BPE','SSM','LEGO','实验报告']
    scores=['20','20','10','10','20','20']
    rows=[[Paragraph(s,styles['cell']) for s in names],
          [Paragraph(s,styles['score']) for s in scores]]
    t=Table(rows,colWidths=[CW/6]*6)
    t.setStyle(TableStyle([
        ('LINEABOVE',(0,0),(-1,0),.7,black),
        ('LINEBELOW',(0,0),(-1,0),.4,black),
        ('LINEBELOW',(0,1),(-1,1),.7,black),
        ('TOPPADDING',(0,0),(-1,-1),5),
        ('BOTTOMPADDING',(0,0),(-1,-1),5),
        ('VALIGN',(0,0),(-1,-1),'MIDDLE'),
    ]))
    _,h=t.wrap(CW,1000)
    need(h)
    t.drawOn(c,M,y-h)
    y-=h+12

styles['body'].fontSize=12
styles['body'].leading=20
start('音乐单词实验作业要求',main=True)
p('项目仓库：<link href="https://github.com/WhatTheLuck/MusicWord" color="#222222">https://github.com/WhatTheLuck/MusicWord</link>','small',gap=2)
p('百度网盘：<link href="https://pan.baidu.com/s/1OI4-crItGPBWdySdjZhI8Q?pwd=wfgv" color="#222222">https://pan.baidu.com/s/1OI4-crItGPBWdySdjZhI8Q?pwd=wfgv</link>　提取码：<b>wfgv</b>','small',gap=2)
section('一、实验任务')
step(1,'<b>选曲：</b>选择 <b>3 首乐曲</b>，可使用曲库或自选 MIDI / MusicXML 文件。')
step(2,'<b>标注：</b>分别标注这 3 首乐曲，划分音乐单词，并为相同或相似片段指定词类。')
step(3,'<b>调参：</b>每首乐曲均使用对应标注，分别运行 ActiveBasis、BPE、SSM 并调整参数，取得较好的匹配结果。保留各曲调参前后的结果用于分析。')
step(4,'<b>创作：</b>在 LEGO 中使用本次发掘的音乐单词，拼接 <b>1 首音乐作品</b>。')
step(5,'<b>报告：</b>记录实验过程，附关键截图，分析标注、调参结果和作品编排。')
section('二、报告内容')
p('• 3 首乐曲各自的来源、分析音轨、标注规则与典型片段。',gap=4)
p('• 每首乐曲的三种算法参数、调参前后结果、匹配效果及误匹配原因。',gap=4)
p('• LEGO 所用音词及其发掘来源、编排截图和创作说明。',gap=4)
section('三、提交材料')
p('<b>实验报告 PDF、3 首乐曲各自的参数与标注 JSON、1 首作品 MIDI。</b>',gap=5)
p('附上 3 首源乐曲文件。每首实验结束后，在顶部“全部页面”栏保存并命名参数预设，下载 JSON；标注和作品分别在对应页面导出。',gap=2)
p('建议压缩为“学号_姓名_音乐单词实验.zip”。',gap=5)
section('四、评分（共 100 分）')
grading()
p('<b>代码改进可酌情加分。</b>在报告中说明修改内容、原因和效果，并附修改文件或补丁。',gap=14)
p('<b>助教：王天乐</b>　18201028598　353722117@qq.com',gap=0)

styles['body'].fontSize=11
styles['body'].leading=18
start('附录一　安装、启动与保存')
section('启动工作台')
step(1,'安装 <b>Node.js 22.12 或更新版本</b>和 <b>Python 3.11</b>。安装时加入系统路径，随后重新打开终端。')
step(2,'从首页的百度网盘链接下载压缩包（提取码 <b>wfgv</b>），或从 GitHub 仓库选择 <b>Code / Download ZIP</b>。解压并保留完整文件夹。Windows 可双击根目录的 start.cmd；也可在包含 package.json 的项目根目录打开终端，运行：')
commands(['npm start'])
step(3,'首次启动会安装依赖，每次启动会构建页面。等终端显示地址后，在浏览器打开 <b>http://127.0.0.1:8770/</b>。保持终端开启，结束时按 Ctrl+C。')
shot('setup-topbar.jpg','图 1　最顶部的本页 / 全部页面预设栏、文件按钮与保存按钮。')
section('选择乐曲与标注')
step(4,'“加载 MIDI”选择内置乐曲；“上传文件”导入 .mid、.midi、.xml、.musicxml 或 .mxl。MusicXML 转换后可下载对应 MIDI。选择音轨后，用“播放音轨”试听。')
step(5,'对 3 首乐曲逐首完成并保存标注，再进入三个算法页面，点击“加载标注数据”载入对应标注与 MIDI。每首均运行三种算法；同一曲目的比较保持音轨和标注层一致。')
section('保存与恢复参数')
step(6,'顶部“本页”和“全部页面”均有<b>预设下拉栏、文件按钮和“保存”</b>。“本页”只影响当前页；“全部页面”包含五页（含 LEGO）及试听设置。点击“保存”后输入名称，再点“保存预设”，配置会加入下拉栏并下载 JSON。')
step(7,'<b>选择下拉预设即加载</b>；文件按钮可读取对应 JSON。分别保存 3 首乐曲的最终预设，名称注明曲目。恢复后再载入对应乐曲和标注；标注 JSON 与 1 首作品 MIDI 另行导出。')
p('启动失败时，先检查 Node.js、Python 版本和网络，再查看终端错误信息。macOS / Linux 同样在项目根目录运行 npm start；Linux 需安装 Python 3.11 对应的 venv 支持。','small')

start('附录二　人工标注')
step(1,'进入“标注”，载入乐曲并勾选待分析音轨。试听乐曲，确定音乐单词的划分依据。')
step(2,'在钢琴卷帘框选一组音符，或在层级树选取 L0 节点；在 L1 类别字典中选择词类，点击“聚合”（也可按 Enter / 空格）。相同或相似片段使用同一词类。')
step(3,'继续标注整首乐曲。需要更高层结构时，选择同层节点再聚合。记录后续算法比较所用的标注层。')
shot('annotation-loaded-topbar.jpg','图 2　标注层级、词框与保存入口；图中为库内已有标注示例。')
step(4,'可在词类卡片中点击“查找相似片段”，调整相似度、起音 / 时长容差及移调范围。逐条试听候选，勾选确认后接受为同类。')
step(5,'在“标注结果”中复核。用“编辑范围”重选音符，或修改词类、删除错误片段；误操作可“撤销”或按 Ctrl+Z（macOS 用 Command+Z）。')
step(6,'点击<b>“保存标注”</b>供其他页面读取，再点击<b>“导出 JSON”</b>保存提交文件。刷新或切换曲目、音轨前先保存。')
p('已有标注从“加载标注数据”查看。若参考已有标注或使用辅助匹配，应在报告中说明。','small')

start('附录三　ActiveBasis')
step(1,'点击“加载标注数据”，载入本次乐曲与标注，在“乐谱量化”核对音轨和标注层。')
step(2,'设置 TPB（每拍刻度数）、模糊核大小和标准差；在“总过程”“初始化字典”中设置初始单词数、随机种子和基元范围。参数可在伪代码输入框或参数区修改。')
step(3,'修改参数后等待自动重算。依次查看初始化字典、相似度响应、拼图重构和字典重学习，点击单词或片段试听。参数含义见“参数滑块与说明”。')
shot('activebasis-rounds-topbar.jpg','图 3　“大轮次”窗口：训练轮次、指标曲线及标注对照。')
step(4,'点击“大轮次”比较各轮结果。“+”可继续一轮；也可填写“本次轮数”，点击“运行 N 轮”继续训练。')
step(5,'对照人工标注、匹配指标与重构误差，调整响应阈值、去重阈值、单词数或模糊参数。比较参数时固定随机种子，记录结果变化。')
step(6,'确定最终参数和轮次，在顶部“本页”栏点击“保存”并命名预设，截取字典、匹配卷帘及指标。报告中说明匹配改善之处和仍存在的问题。')
p('初次进入可能显示已有回放。确认已载入自己的乐曲并完成重算后，再记录结果。','small')

start('附录四　BPE')
step(1,'进入 BPE，通过“加载标注数据”载入本次乐曲与标注，核对音轨和标注层。')
step(2,'在左侧设置全局 TPB、相对时间饱和、相似度方法、匹配阈值及特征权重。先保留一组初始结果。')
step(3,'点击“运行第 1 轮”逐轮合并，或输入目标轮数后点击“运行至 N 轮”。查看卷帘、层级树、词典和词频，点击词框或样例试听。')
shot('bpe-params-topbar.jpg','图 4　BPE 的参数与逐轮运行入口。')
step(4,'打开“仅顶层词”，检查当前轮分词。对照人工标注与指标，观察是否过度合并、划分过碎，或将不同动机归为同类。')
step(5,'调整阈值、特征权重、相似度方法或轮数。参数改变后会从初始层重算到当前轮，等计算完成再比较。')
step(6,'选择分词效果较好的方案，在顶部“本页”栏点击“保存”并命名预设，保留结果截图，在报告中注明最终轮次及选择理由。')

start('附录五　SSM')
step(1,'进入 SSM，通过“加载标注数据”载入本次乐曲与标注，核对音轨和标注层。')
step(2,'设置步长、每拍刻度、起音 / 延音权重及模糊参数；选择 NCC、SAD 或 Texton，调整相似度阈值与“匹配至少（拍）”。')
step(3,'悬停矩阵查看 A、B 的拍位置与相似度；点击斜线固定选择，用“听 A”“听 B”比较片段。结构树、卷帘与矩阵可联动查看。')
shot('ssm-result-topbar.jpg','图 5　原谱、标注卷帘和自相似矩阵；完整矩阵需向下滚动查看。')
step(4,'检查结构树叶子片段与标注是否一致，调整“截断交叠”“去除自相似”及独有 / 补齐片段下限。每次等待重算结束，记录边界与覆盖情况的变化。')
step(5,'查看标注比对指标与历史曲线，在顶部“本页”栏保存选定参数。点击“导出离线 HTML”保留结果，截取矩阵、结构树和指标用于报告。')
p('矩阵过大时可增大步长。“显示矩形框”按需开启；它与“去除自相似”是两个不同控件。','small')

start('附录六　LEGO')
step(1,'从算法结果选取要使用的音词，记下方法、词编号和原曲拍位置。LEGO 可读取标注词典：回到“标注”页，将相应片段整理为词类并保存。')
step(2,'进入 LEGO，在“音词库来源”选择“已保存标注词典”，按曲目筛选音词。点击音词试听，在片段编辑器中调整 F 翻转、A 密度、D 时值和片段拍数，并设置和弦。')
step(3,'把“音词事件实例”拖到“片段编曲”的目标拍；也可选择预置和弦进行，点击“置入和弦进行”。')
shot('lego-composed-topbar.jpg','图 6　音词变奏、和声设置与时间轴编排。')
step(4,'拖动片段调整位置与顺序，拖动两端改变拍数；点击片段继续编辑。播放整体，检查节奏衔接与变化，完成 1 首拼接作品。')
step(5,'点击<b>“导出 MIDI”</b>保存作品，再在顶部<b>“全部页面”栏点击“保存”并命名预设</b>，保留包括 LEGO 编排在内的完整参数。报告中附时间轴截图，说明所用音词与发掘结果的对应关系。')
p('“已保存标注词典”为空时，先回“标注”页保存，再返回 LEGO 重选来源。附录截图用于说明操作，其中的参数和分数不作为评分标准。','small')

end()
assert page==7,page
c.save()
print('Created',page,'pages; bottom positions:',bottoms)
print(OUT)
