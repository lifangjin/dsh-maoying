/**
 * md-table 单测：毛颖创作台轻量 Markdown 渲染器（lib/client.js renderMd）的
 * GFM 管道表格支持——表头行 + |---|---| 分隔行 + 数据行（含对齐语法）、转义
 * 管道 \| 切列豁免、段落兜底截断、宽容列数与先转义后变换的安全底线。
 *
 * renderMd 在浏览器 bundle 的 factory 闭包内、不可 import——测试从源码切出
 * escapeHtml / isSafeLinkUrl / inlineMd / 表格辅助 / renderMd 相邻函数块
 * （`function escapeHtml` 起至 `\n    function MdView` 止，renderMd 之后紧跟
 * MdView），new Function 求值拿纯函数直测。切片标记失效即红并带定位提示，
 * 防未来重排后静默漏测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const START_MARK = '    function escapeHtml'
const END_MARK = '\n    function MdView'
const sliceStart = source.indexOf(START_MARK)
const sliceEnd = source.indexOf(END_MARK)
if (sliceStart === -1 || sliceEnd === -1) {
  throw new Error('[md-table] 无法在 lib/client.js 定位渲染器函数块：切片标记 "function escapeHtml" 或 "function MdView" 未命中——渲染器函数可能已被重排/改名，请同步更新本测试的 START_MARK / END_MARK 后再跑，谨防静默漏测')
}
if (sliceEnd <= sliceStart) {
  throw new Error('[md-table] lib/client.js 函数块顺序异常：MdView 出现在 escapeHtml 之前，切片标记与源码结构不符，请更新 START_MARK / END_MARK')
}
const renderMd = new Function(source.slice(sliceStart, sliceEnd) + '; return renderMd;')()

test('用户真实样例：职级/修为档位表渲染为 thead + tbody 结构', () => {
  const out = renderMd([
    '| 职级 | 修为档位 |',
    '|---|---|',
    '| 宗主 | 元婴 |',
    '| 世家／里长／头人 | 凡人（个别世家自养炼气修士） |',
  ].join('\n'))
  assert.ok(out.includes('<div class="myt-mdTableWrap"><table class="myt-mdTable"><thead>'), out)
  assert.ok(out.includes('<th>职级</th>'), out)
  assert.ok(out.includes('<th>修为档位</th>'), out)
  assert.ok(out.includes('<td>宗主</td>'), out)
  assert.ok(out.includes('<td>元婴</td>'), out)
  assert.ok(out.includes('<td>世家／里长／头人</td>'), out)
  assert.ok(out.includes('<td>凡人（个别世家自养炼气修士）</td>'), out)
  const tbody = (out.match(/<tbody>[\s\S]*<\/tbody>/) || [''])[0]
  assert.equal(tbody.split('<tr>').length - 1, 2, '数据行应为 2 行：' + out)
})

test('对齐语法：:---: 居中 / ---: 右对齐 / --- 无对齐 class', () => {
  const center = renderMd('| a | b |\n|:---:|:---:|\n| 1 | 2 |')
  assert.ok(center.includes('<th class="myt-ta-c">a</th>'), center)
  assert.ok(center.includes('<td class="myt-ta-c">1</td>'), center)
  const right = renderMd('| a | b |\n|---|---:|\n| 1 | 2 |')
  assert.ok(right.includes('<td class="myt-ta-r">2</td>'), right)
  assert.ok(right.includes('<th>a</th>'), right)
  const none = renderMd('| a | b |\n|---|---|\n| 1 | 2 |')
  assert.ok(!none.includes('myt-ta-'), none)
})

test('转义管道 \\| 不切列，单元格内保留字面竖线', () => {
  const out = renderMd('| a \\| b | c |\n|---|---|\n| 1 | 2 |')
  assert.ok(out.includes('<th>a | b</th>'), out)
  assert.equal((out.match(/<th[ >]/g) || []).length, 2, '应只有 2 列表头：' + out)
})

test('非表格：只有 | 行无分隔行 → 落段落不产 <table', () => {
  const alone = renderMd('| a | b |')
  assert.ok(!alone.includes('<table'), alone)
  assert.ok(alone.includes('<p class="myt-mdP">'), alone)
  const plain = renderMd('|a|b|\n普通文本行')
  assert.ok(!plain.includes('<table'), plain)
  assert.ok(plain.includes('<p class="myt-mdP">|a|b|<br>普通文本行</p>'), plain)
})

test('段落截断：段落后紧跟表格时表格独立成块（GitHub 语义）', () => {
  const out = renderMd('前言\n|a|b|\n|---|---|\n|1|2|')
  assert.ok(out.startsWith('<p class="myt-mdP">前言</p>'), out)
  assert.ok(out.indexOf('<table') > out.indexOf('</p>'), out)
  assert.ok(out.includes('<td>1</td><td>2</td>'), out)
  assert.ok(!out.includes('前言<br>'), out)
})

test('数据行列数不齐宽容渲染：缺列补空 td、多列照渲染', () => {
  const short = renderMd('| a | b |\n|---|---|\n| 1 |')
  assert.ok(short.includes('<td>1</td><td></td>'), short)
  const extra = renderMd('| a |\n|---|\n| 1 | 2 |')
  assert.ok(extra.includes('<th>a</th>'), extra)
  assert.ok(extra.includes('<td>1</td><td>2</td>'), extra)
})

test('表头列数 ≠ 分隔行列数不认表（GFM 规范，防误吞分隔线/下文）', () => {
  const mismatch = renderMd('| a | b | c |\n|---|---|\n| 1 | 2 | 3 |')
  assert.ok(!mismatch.includes('<table'), mismatch)
  assert.ok(mismatch.includes('<p class="myt-mdP">'), mismatch)
  const hrTrap = renderMd('战力 | 境界\n---\n下文')
  assert.ok(!hrTrap.includes('<table'), hrTrap)
  const plus = renderMd('| a |\n|---|---|\n| 1 |')
  assert.ok(!plus.includes('<table'), plus)
})

test('安全：单元格内 HTML 保持转义态，无裸标签通道', () => {
  const out = renderMd('| <script>alert(1)</script> | <img src=x onerror=alert(1)> |\n|---|---|\n| 1 | 2 |')
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), out)
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), out)
  assert.ok(!out.includes('<script'), out)
  assert.ok(!out.includes('<img'), out)
})

test('单元格行内格式照常生效（加粗/行内码/删除线/安全链接）', () => {
  const out = renderMd('| 名号 | 备注 |\n|---|---|\n| **宗主** | `元婴` 期 |\n| ~~废柴~~ | [dsh](https://example.com) |')
  assert.ok(out.includes('<td><strong>宗主</strong></td>'), out)
  assert.ok(out.includes('<td><code>元婴</code> 期</td>'), out)
  assert.ok(out.includes('<td><del>废柴</del></td>'), out)
  assert.ok(out.includes('<a href="https://example.com" target="_blank" rel="noreferrer">dsh</a>'), out)
})

test('既有特性回归：围栏码不被表格分支劫持（围栏内 | 照旧进 pre）', () => {
  const out = renderMd('前文\n```\nraw | text\n```\n后文')
  assert.ok(out.includes('<pre class="myt-mdCode"><code>raw | text</code></pre>'), out)
  assert.ok(!out.includes('<table'), out)
})

test('既有特性回归：javascript: 链接白名单拒绝，标题/列表照常', () => {
  const link = renderMd('[点我](javascript:alert(1))')
  assert.ok(!link.includes('<a href="javascript'), link)
  assert.ok(link.includes('[点我](javascript:alert(1))'), link)
  const rest = renderMd('## 标题\n- 甲\n- 乙\n1. 一\n2. 二')
  assert.ok(rest.includes('<h2 class="myt-mdH">标题</h2>'), rest)
  assert.ok(rest.includes('<ul class="myt-mdList"><li>甲</li><li>乙</li></ul>'), rest)
  assert.ok(rest.includes('<ol class="myt-mdList"><li>一</li><li>二</li></ol>'), rest)
})
