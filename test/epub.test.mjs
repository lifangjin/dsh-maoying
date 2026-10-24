/**
 * lib/epub.mjs 单测：CRC32 已知向量、buildZip/buildEpub 产物结构（手解
 * EOCD + central directory 校验偏移自洽，mimetype 首条目且 stored）、
 * escapeXml 对 & < > ' " 全量转义、XML 1.0 非法控制字符替换为 U+FFFD（L8）、
 * emoji/𠮷 书名与正文产物的 XML 良构、paragraphs 形状漂移与 uuid 非法的中文
 * 报错、dosDateTime 的 1980 纪元下限。零依赖：只用 node: 内置模块，产物完整
 * 性用仓内 parseZipEntries 自解校验，不依赖系统 unzip。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { buildEpub, buildZip, crc32, dosDateTime, escapeXml } from '../lib/epub.mjs'

/** 造一份最小书稿：两章，书名/正文含 emoji 与生僻字 𠮷 及各类待转义字符。 */
const SAMPLE = {
  title: '𠮷野家与😀的书',
  author: '佚名 & <作者>',
  uuid: '3f2a1b9c-8d4e-4f0a-9b1c-2d3e4f5a6b7c',
  chapters: [
    {
      heading: '卷一-章一 & <开端> "引号" \'单引\'',
      paragraphs: ['第一段 & <正文> "双引" \'单引\' 😀', '𠮷 第二段'],
    },
    { heading: '卷一-章二', paragraphs: ['正文乙'] },
  ],
}

test('crc32：标准校验向量 "123456789" → 0xCBF43926', () => {
  assert.equal(crc32(Buffer.from('123456789', 'utf8')), 0xcbf43926)
  assert.equal(crc32(Buffer.alloc(0)), 0, '空输入 CRC32 为 0')
})

/**
 * 手工解析 zip（零依赖）：从尾部定位 EOCD 签名，遍历 central directory，
 * 逐条目回读 local header 并核对签名 / 名称 / 长度 / CRC——偏移链自洽即
 * 结构合法，不依赖任何 zip 库。
 */
function parseZipEntries(buf) {
  // EOCD 固定 22 字节、签名 0x06054b50；本 writer 不写注释，从尾部就近找，
  // 仍向后多扫一段注释上限（65535）以防未来加注释。
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, '应能定位 EOCD 签名')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  assert.equal(eocd, cdOffset + cdSize, 'EOCD 应紧跟 central directory 末尾（无注释）')
  const entries = []
  let p = cdOffset
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, `第 ${i + 1} 条 central directory 签名`)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const packedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    // 回读 local header，校验偏移与内容自洽
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} local header 签名`)
    assert.equal(buf.readUInt16LE(localOffset + 8), method, `${name} 压缩方法一致`)
    assert.equal(buf.readUInt16LE(localOffset + 26), nameLen, `${name} 文件名长度一致`)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + nameLen + localExtraLen
    const data = buf.subarray(dataStart, dataStart + size)
    assert.equal(data.length, size, `${name} 数据长度一致`)
    assert.equal(packedSize, size, `${name} stored 压缩前后等长`)
    assert.equal(crc32(data), crc, `${name} CRC 自洽`)
    entries.push({ name, method, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  assert.equal(p, cdOffset + cdSize, 'central directory 应恰好遍历到声明长度')
  return entries
}

test('buildEpub：mimetype 首条目且 stored，zip 偏移自洽（手解 EOCD + central directory）', () => {
  const entries = parseZipEntries(buildEpub(SAMPLE))
  assert.equal(entries[0].name, 'mimetype', 'mimetype 必须是第一条目（EPUB 规范）')
  assert.equal(entries[0].method, 0, 'mimetype 必须 stored（无压缩）')
  assert.equal(entries[0].data.toString('utf8'), 'application/epub+zip', 'mimetype 内容不带换行')
  assert.deepEqual(
    entries.map((e) => e.name),
    [
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/style.css',
      'OEBPS/chap-01.xhtml',
      'OEBPS/chap-02.xhtml',
    ],
    '条目顺序：mimetype → container → opf → nav → css → 各章',
  )
  for (const e of entries) assert.equal(e.method, 0, `${e.name} 全部条目均 stored`)
})

test('buildZip：空条目表仍产出合法的空 zip 结构', () => {
  const entries = parseZipEntries(buildZip([]))
  assert.equal(entries.length, 0)
})

test('buildEpub 产物完整性：全条目按 central directory 自洽回读（替代系统 unzip -t，零外部依赖）', () => {
  // 原用例靠系统 `unzip -t`（缺席即 skip，违反 AGENTS.md「skip 只允许 yaml 包
  // 条件跳过一类」门禁）——改用上方 parseZipEntries 仓内自解：EOCD/central
  // directory/local header 三层偏移、stored 等长与 CRC32 逐条自洽，走完即无损坏，
  // 断言力度与 unzip -t 相当且任何环境恒跑。
  const entries = parseZipEntries(buildEpub(SAMPLE))
  assert.ok(entries.length >= 7, `产物应有完整条目面，实得 ${entries.length} 条`)
  assert.equal(entries[0].name, 'mimetype', 'mimetype 仍须是第一条目')
  for (const e of entries) assert.ok(e.data.length >= 0, `${e.name} 数据可回读`)
})

test("escapeXml：& < > ' \" 五类字符全量转义，且 & 先转不重复", () => {
  assert.equal(escapeXml("&<>'\""), '&amp;&lt;&gt;&apos;&quot;')
  assert.equal(escapeXml('&&'), '&amp;&amp;')
  assert.equal(escapeXml('<script>&</script>'), '&lt;script&gt;&amp;&lt;/script&gt;')
  assert.equal(escapeXml(null), '', 'null 兜空串')
  assert.equal(escapeXml(undefined), '', 'undefined 兜空串')
  assert.equal(escapeXml(123), '123', '非字符串先 String 化')
})

test('escapeXml：XML 1.0 非法控制字符替换为 U+FFFD（L8），合法 \\t \\n \\r 原样保留', () => {
  // \x00-\x08、\x0B、\x0C、\x0E-\x1F 全段逐字符替换
  const dirty = '\x00\x01\x07\x08\x0B\x0C\x0E\x15\x1F'
  assert.equal(escapeXml(dirty), '\uFFFD'.repeat(dirty.length), '非法控制字符逐一替换为 U+FFFD')
  // 合法控制字符（制表/换行/回车）不得误伤
  assert.equal(escapeXml('a\tb\nc\rd'), 'a\tb\nc\rd')
  // 全链路：含控制字符的正文打出的章 XHTML 不再含非法控制字符，且脏点可见
  const byName = new Map(
    parseZipEntries(buildEpub({ ...SAMPLE, chapters: [{ heading: '脏章\x00', paragraphs: ['一段\x1F正文'] }] })).map((e) => [
      e.name,
      e.data.toString('utf8'),
    ]),
  )
  const chap = byName.get('OEBPS/chap-01.xhtml')
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(chap), '章 XHTML 不含 XML 1.0 非法控制字符')
  assert.ok(chap.includes('\uFFFD'), '脏字符位置留下 U+FFFD 可见痕迹')
})

test('buildEpub：emoji / 𠮷 书名与正文产物 XML 良构（转义正确 + 标签配平）', () => {
  const byName = new Map(parseZipEntries(buildEpub(SAMPLE)).map((e) => [e.name, e.data.toString('utf8')]))
  const opf = byName.get('OEBPS/content.opf')
  const nav = byName.get('OEBPS/nav.xhtml')
  const chap1 = byName.get('OEBPS/chap-01.xhtml')
  // emoji/生僻字无需转义、原样入产物；特殊字符必须已成实体
  assert.ok(opf.includes(`<dc:title>${SAMPLE.title}</dc:title>`), '书名完整入 OPF')
  assert.ok(chap1.includes('<p>第一段 &amp; &lt;正文&gt; &quot;双引&quot; &apos;单引&apos; 😀</p>'), '正文特殊字符全转义')
  assert.ok(chap1.includes('𠮷 第二段'), '生僻字 𠮷 原样保留')
  assert.ok(nav.includes('<li><a href="chap-01.xhtml">卷一-章一 &amp; &lt;开端&gt; &quot;引号&quot; &apos;单引&apos;</a></li>'), 'nav 标题转义')
  // 简单结构断言（不引 XML 解析器）：XML 声明在头、控制标签配平、实体外无裸 &
  for (const name of ['META-INF/container.xml', 'OEBPS/content.opf', 'OEBPS/nav.xhtml', 'OEBPS/chap-01.xhtml', 'OEBPS/chap-02.xhtml']) {
    const xml = byName.get(name)
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), `${name} 带 XML 声明`)
    assert.equal((xml.match(/<p>/g) ?? []).length, (xml.match(/<\/p>/g) ?? []).length, `${name} <p> 配平`)
    assert.equal((xml.match(/<h2>/g) ?? []).length, (xml.match(/<\/h2>/g) ?? []).length, `${name} <h2> 配平`)
    // 剥掉五种合法实体后不应再有裸 & ——有即说明转义遗漏
    assert.ok(!/&(?!(amp|lt|gt|apos|quot);)/.test(xml), `${name} 无未转义的裸 &`)
  }
})

test('buildEpub：uuid 非 36 位 UUID 形状 → 中文 TypeError', () => {
  assert.throws(
    () => buildEpub({ ...SAMPLE, uuid: 'not-a-uuid' }),
    (err) => err instanceof TypeError && err.message.includes('uuid 必须是 36 位 UUID'),
    '形状不对的字符串 uuid 必须被拦下',
  )
  assert.throws(
    () => buildEpub({ ...SAMPLE, uuid: 'g2a1b9c-8d4e-4f0a-9b1c-2d3e4f5a6b7c' }),
    TypeError,
    '非 hex 字符（g）必须被拦下',
  )
  assert.throws(() => buildEpub({ ...SAMPLE, uuid: undefined }), TypeError)
})

test('buildEpub：chapters[].paragraphs 形状漂移 → 中文报错而非 TypeError 栈', () => {
  assert.throws(
    () => buildEpub({ ...SAMPLE, chapters: '不是数组' }),
    (err) => err instanceof TypeError && err.message.includes('chapters 必须是章节数组'),
  )
  assert.throws(
    () => buildEpub({ ...SAMPLE, chapters: [{ heading: '章一', paragraphs: '段落串化漂移' }] }),
    (err) => err instanceof TypeError && err.message.includes('paragraphs 必须是段落数组'),
  )
  assert.throws(
    () => buildEpub({ ...SAMPLE, chapters: [{ heading: '章一' }] }),
    /paragraphs 必须是段落数组/,
    'paragraphs 缺失（undefined）同样拦下',
  )
  assert.throws(
    () => buildEpub({ ...SAMPLE, chapters: [null] }),
    /paragraphs 必须是段落数组/,
    '章节项为 null 也拦下',
  )
})

test('dosDateTime：正常编码 + 早于 1980 年份 clamp 到纪元', () => {
  // 正常时间：各字段按位编码（本地时区口径，与 Date 构造一致）
  const normal = dosDateTime(new Date(2024, 0, 15, 10, 30, 20))
  assert.equal(normal.time, (10 << 11) | (30 << 5) | (20 >> 1), '时分秒按 DOS 位段编码')
  assert.equal(normal.day, ((2024 - 1980) << 9) | (1 << 5) | 15, '年月日按 DOS 位段编码')
  // 系统时钟早于 1980：年份必须 clamp 到 1980，不得按 7 位回绕成 2107+ 的未来
  const clamped = dosDateTime(new Date(1979, 11, 31, 23, 59, 58))
  assert.equal(clamped.day >> 9, 0, '年份位为 0（即 1980）')
  assert.equal((clamped.day >> 5) & 0xf, 12, '月位不受 clamp 影响（12 月）')
  assert.equal(clamped.day & 0x1f, 31, '日位不受 clamp 影响（31 日）')
  // clamp 产物可往返解码：年 = 位段 + 1980
  const year = (clamped.day >> 9) + 1980
  assert.equal(year, 1980)
})
