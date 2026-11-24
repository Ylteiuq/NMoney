# 账本网页

页面使用原生 HTML、CSS 和 JavaScript。项目根目录运行 `python3 app.py --open`，即可通过本地服务查看。

| 文件 | 作用 |
| --- | --- |
| [index.html](index.html) | 概览、交易明细、相似支出、导入账单四个视图，以及编辑用途和关联回款的对话框。 |
| [style.css](style.css) | 颜色、排版、表格、图表和小屏布局。 |
| [app.js](app.js) | 读取账本数据，处理筛选、排序、分页、图表和操作请求。`clusterOutflows` 同时供浏览器和本机 Node 初分脚本使用。 |
| [favicon.svg](favicon.svg) | 浏览器标签页图标。 |

**从分类图追到一条流水。** 从概览点分类，地址中的 `#` 片段记录选中的分类和筛选条件。`applyRoute` 恢复视图，`renderDetails` 对服务返回的 `rows` 应用分类、关键词和排序，每页展示 40 笔。原金额和个人实付都以分传输，在展示时转换为元。

**从页面操作追到数据库。** 普通写入经 `post` 发送 JSON，并带上服务要求的请求头。导入经 `importFiles` 直接传文件字节。在仍运行旧版服务的过渡期，`saveDaily` 可暂存日常选择，`syncChoices` 按平台和订单号将它们回写到账本。

请求和响应字段见[接口说明](../nmoney/controllers/README.md)。添加新的静态资源 URL 时，在后端的[路由表](../nmoney/http/router.py) 注册文件和类型。
