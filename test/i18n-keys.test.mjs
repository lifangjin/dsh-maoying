/**
 * i18n 键集对齐单测：lib/client.js 内 zh/en 两份词典键数必须一致且键集对称。
 * 新增文案只加一边是最常见的漏网事故——tt() 缺键回落 zh，英文界面会裸插中文。
 *
 * 词典在浏览器 bundle 的 factory 闭包内、不可 import——照 md-table.test.mjs
 * 的源码切片先例：切 `var I18N = {` 起至收尾 `\n    };` 止（词典是纯对象
 * 字面量，无外部引用，new Function 可安全求值）。切片标记失效即红并带定位
 * 提示，防未来重排后静默漏测。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const START_MARK = '    var I18N = {'
const END_MARK = '\n    };'
const sliceStart = source.indexOf(START_MARK)
const sliceEnd = source.indexOf(END_MARK, sliceStart)
if (sliceStart === -1 || sliceEnd === -1) {
  throw new Error('[i18n-keys] 无法在 lib/client.js 定位 I18N 词典块：切片标记 "var I18N = {" 或收尾 "};" 未命中——词典可能已被重排/改名，请同步更新本测试的 START_MARK / END_MARK 后再跑，谨防静默漏测')
}
if (sliceEnd <= sliceStart) {
  throw new Error('[i18n-keys] lib/client.js 切片区间异常：词典收尾出现在开头之前，请检查 START_MARK / END_MARK')
}
const I18N = new Function(source.slice(sliceStart, sliceEnd + END_MARK.length) + '; return I18N;')()

test('zh/en 词典键数一致（键数不等即 fail）', () => {
  const zh = Object.keys(I18N.zh)
  const en = Object.keys(I18N.en)
  assert.equal(zh.length, en.length, `键数不等：zh ${zh.length} / en ${en.length}，缺的那边大概率是新增文案漏加`)
})

test('zh/en 词典键集对称（单向缺失即 fail，报出首个差异键）', () => {
  const onlyZh = Object.keys(I18N.zh).filter((k) => !Object.prototype.hasOwnProperty.call(I18N.en, k))
  const onlyEn = Object.keys(I18N.en).filter((k) => !Object.prototype.hasOwnProperty.call(I18N.zh, k))
  assert.deepEqual(onlyZh, [], `只在 zh 存在的键（en 漏加）：${onlyZh.join(', ')}`)
  assert.deepEqual(onlyEn, [], `只在 en 存在的键（zh 漏加）：${onlyEn.join(', ')}`)
})
