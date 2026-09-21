# 插入片段的上下文差异说明（INSERT-CONTEXT）

复现脚本：`repro/insert-fragment-context.spec.ts`（`npx vitest run repro/insert-fragment-context.spec.ts`）。
场景：`load('<table id=t><tbody id=b></tbody></table>')` 后，向 `#b` 塞同一段 `<td>a</td>`，分别走十二个入口。

## 一、十二行实测结果

| 入口 | rows（`#b > tr` 数量） | stable（存盘再读形状一致） |
| --- | --- | --- |
| append | 0 | NO |
| prepend | 0 | NO |
| before | 0 | NO |
| after | 0 | NO |
| appendTo | 0 | NO |
| prependTo | 0 | NO |
| insertBefore | 0 | NO |
| insertAfter | 0 | NO |
| replaceWith | 0 | NO |
| wrap | 0 | NO |
| wrapInner | 0 | NO |
| html(setter) | 1 | yes |

补充实测细节：

- 十一个插入入口存出来的字符串是 `<tbody id="b"><td>a</td></tbody>`（`td` 直接挂在 `tbody` 下）；再 `load()` 读回来变成 `<tbody id="b"><tr><td>a</td></tr></tbody>`，`#b > tr` 从 0 变 1，所以 stable 为 NO。
- `wrap` 一行塞的是 `<i></i>` 而不是 `td`，rows 本来就是 0；它 stable 为 NO 是因为 `<i>` 出现在 `table` 内部属非法位置，重读时被 foster-parenting 挪到 `<table>` 前面（`<i></i><table>…`）。
- `html(setter)` 直接得到 `<tbody id="b"><tr><td>a</td></tr></tbody>`，重读不变。

## 二、为什么是两个结果：解析片段时传没传上下文元素

两条路在 `src/api/manipulation.ts` 里分岔：

- 十一个插入入口（`append`/`prepend`/`before`/`after`/`replaceWith`/`wrap`/`wrapInner` 直接调用，`appendTo`/`prependTo`/`insertBefore`/`insertAfter` 内部转发给前四个）都经过 `_makeDomArray`（src/api/manipulation.ts:45），字符串走 `this._parse(elem, this.options, false, null)` —— **context 传的是 `null`**。
- `html(str)` setter（src/api/manipulation.ts:1004）走 `this._parse(str, this.options, false, el)` —— **context 传的是目标元素本身**（这里是 `<tbody>`）。

context 最终交给 parse5 的 `parseFragment(context, content, options)`（src/parsers/parse5-adapter.ts:32）。parse5 的 `getFragmentParser` 里写着：没给 context 时**用 `<template>` 元素当上下文**，以“宽容”方式解析。`<template>` 上下文里 `<td>` 不触发任何表格插入模式的补全，`td` 原样成为片段根节点，于是直接挂到 `tbody` 下，没有 `tr`。

而 context 是 `<tbody>` 时，HTML5 片段解析算法把初始插入模式重置为 `IN_TABLE_BODY`；该模式下遇到 `td`/`th` 起始标签，规范（及 parse5 的 `startTagInTableBody`）要求**先插入一个假 `<tr>` 元素再处理 `td`**，于是得到 `<tr><td>a</td></tr>`。

没传 context 时解析器“不补行元素”不是疏忽，而是规范行为：片段解析的补全规则完全由上下文元素决定，`<template>` 上下文的设计目标就是不做任何表格相关的结构推断。解析器不知道你接下来要把片段插进 `tbody`，自然没有依据补 `tr`。

存盘再读形状会变，是因为序列化只是按当前树原样输出 `<tbody><td>…`；而 `load()` 是**整文档解析**，`tbody` 在文档里会把插入模式带进 `IN_TABLE_BODY`，于是同一个 `<td>` 这次被补上了 `<tr>`。也就是说：写盘时用的是“无上下文片段规则”，读回时用的是“有完整上下文的文档规则”，两套规则对同一个字节串给出两棵树。

## 三、option 那种片段为什么两侧一致

`<option>a</option>` 这类片段不属于任何“需要上下文补全”的类别：在 `<template>` 上下文（插入入口）和 `<select>` 上下文（`html()` setter）里，解析结果都是一模一样的 `<option>a</option>`，没有隐含元素、没有丢弃。所以两条路造出的树相同。

存盘再读也一致：序列化得到 `<select id="s"><option>a</option></select>`，整文档重解析时 `option` 在 `select` 里是合法内容，不触发 foster-parenting、不触发隐含元素补全，读回来的树与写盘前逐字节相同，stable 为 yes。

换句话说：两侧是否一致，取决于片段是否落在“解析结果随上下文元素变化”的集合里（表格类的 `td`/`th`/`tr`/`tbody` 等是典型），`option`、`div`、`span`、`li` 这类普通元素不在其中。

## 四、统一方向与代价

方向：让 `_makeDomArray` 像 `html()` setter 一样，把**目标容器元素作为 context 传给 `_parse`**（即在 `_insert`、`wrap`、`replaceWith` 等调用处把当前 `el` 传下去），使所有入口都按“片段将被插入的位置”解析。这样十二个入口对 `<td>` 都会补出 `<tr>`，且写盘再读形状不变（写读两侧都是表格规则）。

代价：一批今天“能读到”的结构会消失或变形，因为 `<template>` 的宽容解析被替换成了上下文敏感解析——

- 今天 `$('#b').append('<td>a</td>')` 后 `$('#b > td')` 能读到 1 个直接子元素、`$('#b td').parent()` 是 `tbody`；统一后 `td` 被包进隐含的 `<tr>`，`$('#b > td')` 变 0，父元素变成 `tr`。
- 更极端的写法例子：今天 `$('#d').append('<td>a</td>')`（`#d` 是普通 `div`）会在 `div` 下留下一个 `<td>` 元素；统一后按 `div` 上下文解析，`td` 标签会被当作解析错误丢弃，只剩文本 `a`，`$('#d td')` 从 1 变 0。

凡是依赖“非法表格片段被原样保留”的现有代码，都会在统一后读到不同的树；这是让十二个入口语义对齐 `html()` 必须付出的行为变更。
