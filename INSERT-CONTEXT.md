# 片段插入上下文：十二行现状与原因

复现命令（实现与用例均未改动）：

```
npx vitest run repro/insert-fragment-context.spec.ts
```

实测环境：Node v22.22.1、Vitest 4.1.11、parse5 8.0.1（`node_modules` 实际安装版本）。
片段固定为 `<td>a</td>`，容器为 `<tbody id="b">`，`rows` 是插入后 `$('#b > tr').length`，
`stable` 是把 `$.html()` 的结果再 `load()` 回来与原序列化串是否一致。

## 一、十二行现状（确定值）

按脚本里 apis 的顺序：

| # | 入口 | rows | stable |
|---|------|------|--------|
| 1 | append | 0 | 否（NO） |
| 2 | prepend | 0 | 否（NO） |
| 3 | before | 0 | 否（NO） |
| 4 | after | 0 | 否（NO） |
| 5 | appendTo | 0 | 否（NO） |
| 6 | prependTo | 0 | 否（NO） |
| 7 | insertBefore | 0 | 否（NO） |
| 8 | insertAfter | 0 | 否（NO） |
| 9 | replaceWith | 0 | 否（NO） |
| 10 | wrap | 0 | 否（NO） |
| 11 | wrapInner | 0 | 否（NO） |
| 12 | html(setter) | 1 | 是（yes） |

即：十一个插入入口全部 `rows=0, stable=否`；只有 `html(setter)` 是 `rows=1, stable=是`。

## 二、为什么两种结果：片段解析时有没有告诉解析器挂在谁下面

差别不在“插入”动作，而在字符串被解析成节点那一刻有没有传**上下文元素（context）**。

- **html(setter) 传了。** `src/api/manipulation.ts` 的 `html` setter 用
  `this._parse(str, this.options, false, el)` 解析字符串，第四个参数是目标元素本身
  （这里就是 `#b` 这个 `tbody`），见 `src/api/manipulation.ts:1004`。
- **十一个插入入口都没传。** 它们统一走 `_makeDomArray`，里面是
  `this._parse(elem, this.options, false, null)`，context 恒为 `null`，
  见 `src/api/manipulation.ts:45`。`append/prepend/before/after` 经 `_insert` 调它；
  `appendTo/prependTo/insertBefore/insertAfter/replaceWith/wrap/wrapInner` 解析片段时
  同样汇聚到这里。`appendTo` 这类入口更靠前：`$('<td>a</td>')` 建集合时还不知道目标，
  字符串在那时就已按 `null` context 解析完了。

`_parse` 在默认 HTML 模式下走到 `parseFragment(context, content, options)`
（`src/parsers/parse5-adapter.ts`）。parse5 对 `context == null` 的处理是：**人造一个
`<template>` 元素当片段上下文**，按“宽容（forgiving）”方式解析
（parse5 `Parser.getFragmentParser`：无 context 时
`fragmentContext = createElement('template', ...)`，并压入 in-template 插入模式）。

在 `<template>` 上下文里，解析器不在任何表格插入模式（in table / in table body /
in row / in cell）中，`<td>` 只是一个普通起始标签，直接收进片段根，**表格那套
“遇到 td 先补 tr、缺 tbody 再补 tbody”的隐式标签规则根本不会被触发**。cheerio 随后
只是把这些已解析好的节点直接挂到目标父节点下，DOM 拼接动作本身不做任何合法性修正。
于是 `append` 等入口造出的活树是 `tbody > td`，`td` 直接挂在容器下面，
`$('#b > tr')` 取不到行，rows 为 0。`before/after/replaceWith` 更进一步，`td`
被直接挂到 `table` 下（tbody 之外）。

而 `html(setter)` 传了 `tbody` 作上下文：片段按 in-table-body 模式解析，遇到 `<td>`
起始标签时规范要求先隐式插入一个 `<tr>`，再把 td 放进去。所以活树是
`tbody > tr > td`，即正常的“行里有格子”，rows 为 1。

### 为什么存盘再读回来行数从 0 变 1、stable 为否

`$.html()` 序列化只把当前这棵（非法的）树原样输出，不补结构，例如 append 的输出是：

```
<table id="t"><tbody id="b"><td>a</td></tbody></table>
```

`load(flat)` 走的是**全文档解析**（`parseDocument`，不是片段解析），表格插入模式全部
生效：

- `tbody` 直接含 `td`（append/prepend/appendTo/prependTo/wrapInner）：再解析时补出
  `<tr>`，变成 `tbody > tr > td`，所以行数 0 → 1；
- `table` 直接含 `td`、tbody 在旁边（before/after/insertBefore/insertAfter/
  replaceWith）：再解析时按 foster parenting 等规则把 td 收进新补的
  `tbody > tr` 里；
- `wrap` 的 `<i><tbody></tbody></i>`（table 里非法嵌 i）：再解析时 `<i>` 被移出
  table，变成 `<i></i><table>...`。

因为活树的序列化串与“再解析一次得到的树”的序列化串不同，十一个入口 stable 都是否。
`html(setter)` 的活树本来就是合法的 `tbody > tr > td`，往返幂等，所以 stable 是是。

## 三、option 那种片段为什么两侧一致、存盘再读回来发生了什么

把片段换成 `<option>o</option>`、容器换成 `<select>` 时，`append`（null →
`<template>` 上下文）与 `html(setter)`（`select` 上下文）产出的都是同一个孤零零的
`option` 节点：option 不属于表格内容模型，`<template>` 和 `<select>` 两个上下文都不会
为它隐式补任何标签，解析结果与 context 无关。节点挂进 select 后是合法的
`select > option`。

存盘再读回来时它经历的流程完全一样——先 `$.html()` 原样序列化，再 `load()` 全文档
解析——只是这棵树没有非法层级，全文档解析不需要做任何修复，重新得到的还是
`select > option`，两次序列化串相同，往返幂等。也就是说，不是 option 走了别的路，
而是“解析期无需补结构 + 树本身合法”让两条路、两次往返的形状恰好一致。（两次全文档
序列化都带相同的 `<html><head></head><body>...` 外壳，这部分两侧相同，不构成差异。）

## 四、统一方向、代价与规避写法

**统一方向（一句话）**：让十一个插入入口与 `html(setter)` 一样，在插入点以**目标元素
为 context** 解析片段，把表格结构在解析期补齐，而不是用 `null`（实际是 `<template>`）
宽容解析后裸挂节点。

代价是今天能读到的一些节点，修复后会读不到：

- `$('#b').append('<td>a</td>')` 之后，今天 `$('#b > td')` 长度是 1、`$('#b').children()`
  直接拿到 `td`；修复后 td 外面会多一层 `tr`，`$('#b > td')` 变成 0，直接遍历
  `tbody.children` 拿到的也是 `tr` 而不是 `td`。这类代码必须改成读
  `$('#b td')` 或 `$('#b > tr > td')`。
- `before/after/replaceWith` 的目标在 `table` 而非 `tbody`，补结构还涉及 foster
  parenting；即使解析期补全，“活树”与“序列化再读回”的差异也需要调用方一并核对。
- `$('<td>…</td>').appendTo(...)` 这类入口构造集合时没有目标，需要改成在真正插入时
  按目标 context 重新解析，行为变化面最大。

**今天就可用、两条路径结果一致的写法**：片段里把行写全——

```js
$('#b').append('<tr><td>a</td></tr>');
```

实测这样 append 与 `html(setter)` 都是 `rows=1`、`stable=是`，不依赖修复，也不依赖
宽容解析。
