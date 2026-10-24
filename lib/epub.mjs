/**
 * lib/epub.mjs — 零依赖 EPUB 3 打包器（maoying export --format epub 专用）
 *
 * 两层职责：
 *   1) buildZip：手写 stored（无压缩）zip writer——local file header +
 *      central directory + end record，CRC32 用表格法。没有压缩，胜在零依赖
 *      且行为可预期；mimetype 条目必须第一个入列且 stored（EPUB 规范要求，
 *      否则阅读器拒认）。
 *   2) buildEpub：拼出 EPUB 3 最小合法结构——
 *        mimetype                     application/epub+zip（无换行）
 *        META-INF/container.xml       指向 OEBPS/content.opf
 *        OEBPS/content.opf            元数据 + manifest + spine（nav 在列）
 *        OEBPS/nav.xhtml              toc nav 按章列链接
 *        OEBPS/style.css              极简正文样式
 *        OEBPS/chap-NN.xhtml          每章一文件，正文按段 <p> 包裹
 *
 * 入参 chapters 由调用方（bin/maoying.mjs）准备：[{ heading, paragraphs }]，
 * heading 为「卷X-章Y 标题」一行的展示标题，paragraphs 为分段后的正文字符串
 * 数组——本模块只管 XML 转义与打包，不做章节解析。
 */

/** CRC32 查表（反射多项式 0xEDB88320，与 zlib/zip 通用口径一致）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC32：入参 Buffer，返回无符号 32 位整数。 */
export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/**
 * 转 DOS 时间（zip 头用，本地时区；秒精度 2 秒一档）。导出仅为测试可直接
 * 断言 1980 纪元等边界。
 */
export function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f)
  // 年份下限 clamp 到 1980：DOS 时间纪元从 1980 年起、年份只存 7 位，更早的
  // 系统时钟（或被拨错的机器时间）会按无符号位回绕映射成 2107+ 的「未来」，
  // 统一按 1980 处理保证 zip 头时间不早于纪元。
  const year = Math.max(date.getFullYear(), 1980)
  const day =
    (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f)
  return { time, day }
}

/**
 * zip writer：全部条目 stored（method 0，压缩前后等长）。entries 有序，
 * mimetype 必须排第一（EPUB 规范）。文件名走 UTF-8（本包条目名全是 ASCII，
 * 不设通用语言标志位也安全）。
 */
export function buildZip(entries) {
  const { time, day } = dosDateTime(new Date())
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')
    const crc = crc32(body)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header 签名
    local.writeUInt16LE(20, 4) // 需要的解压版本：2.0（stored 够用）
    local.writeUInt16LE(0, 6) // 通用标志位
    local.writeUInt16LE(0, 8) // 压缩方法：stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18) // 压缩后尺寸
    local.writeUInt32LE(body.length, 22) // 原始尺寸
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra 长度
    localParts.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory 签名
    central.writeUInt16LE(20, 4) // 打包版本
    central.writeUInt16LE(20, 6) // 需要的解压版本
    central.writeUInt16LE(0, 8) // 通用标志位
    central.writeUInt16LE(0, 10) // 压缩方法：stored
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra 长度
    central.writeUInt16LE(0, 32) // 注释长度
    central.writeUInt16LE(0, 34) // 起始盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // local header 偏移
    centralParts.push(central, nameBuf)

    offset += 30 + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory 签名
  end.writeUInt16LE(0, 4) // 本盘号
  end.writeUInt16LE(0, 6) // central directory 起始盘号
  end.writeUInt16LE(entries.length, 8) // 本盘条目数
  end.writeUInt16LE(entries.length, 10) // 总条目数
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16) // central directory 起始偏移
  end.writeUInt16LE(0, 20) // 注释长度
  return Buffer.concat([...localParts, centralBuf, end])
}

/**
 * XML 文本转义：& 必须先转（否则把刚生成的 &amp; 又转一遍），再 < > 与引号。
 * 章节正文与标题里出现的都过这里；属性值一律用生成的 ASCII 名不走它，引号
 * 转义属防御纵深（将来属性值万一改走用户输入也不破 XML）。
 *
 * L8：XML 1.0 非法控制字符（\x00-\x08、\x0B、\x0C、\x0E-\x1F；\t \n \r 合法
 * 保留）先替换为 U+FFFD 再转义——混入即产非法 XHTML，阅读器可能拒载整本。
 * 选替换不选剥离：脏字符多半是复制粘贴事故，U+FFFD 给作者与阅读器留下
 * 「这里有脏字符」的可见痕迹，静默剥除会无声丢字。
 */
export function escapeXml(text) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** XML 声明 + DOCTYPE 头：三个 XHTML 文件共用。 */
const XHTML_PROLOG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
`

/** html 开标签：XHTML 命名空间 + epub 命名空间（nav 的 epub:type 要用）。 */
const XHTML_HTML_OPEN =
  '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">'

/** 极简正文样式：行距拉开、段落首行缩进两字，别的不折腾。 */
const STYLE_CSS = `body { line-height: 1.7; margin: 1em; }
h2 { font-size: 1.2em; margin: 1.2em 0 0.8em; }
p { margin: 0.4em 0; text-indent: 2em; }
`

/** container.xml：OPF 只有一个，指到 OEBPS/content.opf。 */
function containerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`
}

/** 章节包内文件名（不含 OEBPS/ 前缀）：chap-01.xhtml 起两位序号。 */
function chapFile(index) {
  return `chap-${String(index + 1).padStart(2, '0')}.xhtml`
}

/** content.opf：元数据 + manifest + spine。uuid 由调用方给（randomUUID）。 */
function contentOpf({ title, author, uuid, chapters, modified }) {
  // uuid 只接受 36 位 hex-dash 形状（即 crypto.randomUUID() 的产物）：它不经
  // 转义直接内插进 XML，入前形状校验是调用方契约的硬保证——脏数据在这里
  // 炸出中文报错，而不是产出被注入的 OPF。
  if (typeof uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(uuid)) {
    throw new TypeError(`buildEpub: uuid 必须是 36 位 UUID 字符串（crypto.randomUUID() 产物），实得「${String(uuid)}」`)
  }
  const manifestItems = chapters
    .map((_, i) => `    <item id="c${String(i + 1).padStart(2, '0')}" href="${chapFile(i)}" media-type="application/xhtml+xml"/>`)
    .join('\n')
  const spineRefs = chapters
    .map((_, i) => `    <itemref idref="c${String(i + 1).padStart(2, '0')}"/>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:${uuid}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
${manifestItems}
  </manifest>
  <spine>
    <itemref idref="nav"/>
${spineRefs}
  </spine>
</package>
`
}

/** nav.xhtml：toc nav 按章列链接（不分组，与 spine 顺序一致）。 */
function navXhtml({ chapters }) {
  const items = chapters
    .map((ch, i) => `      <li><a href="${chapFile(i)}">${escapeXml(ch.heading)}</a></li>`)
    .join('\n')
  return `${XHTML_PROLOG}${XHTML_HTML_OPEN}
<head>
  <title>目录</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>目录</h1>
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`
}

/** 单章 XHTML：标题作 h2，正文逐段 <p>（段落文本已在入参里分好）。 */
function chapXhtml(chapter) {
  const paragraphs = chapter.paragraphs.map((p) => `  <p>${escapeXml(p)}</p>`).join('\n')
  return `${XHTML_PROLOG}${XHTML_HTML_OPEN}
<head>
  <title>${escapeXml(chapter.heading)}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <h2>${escapeXml(chapter.heading)}</h2>
${paragraphs}
</body>
</html>
`
}

/**
 * 组一个 EPUB 3 的 zip Buffer。入参：
 *   title/author  书名与作者（缺省由调用方兜成「未命名书稿」/「佚名」）
 *   uuid          dc:identifier 用（调用方 crypto.randomUUID()）
 *   chapters      [{ heading, paragraphs }]，顺序即 spine 顺序
 */
export function buildEpub({ title, author, uuid, chapters }) {
  // 形状兜底：chapters 必须是数组，且每章 paragraphs 必须是段落数组——上游
  // （章节解析侧）形状漂移时在这里给出带章号的中文报错，而不是抛 undefined
  // 调 .map 的 TypeError 原始栈。
  if (!Array.isArray(chapters)) {
    throw new TypeError(`buildEpub: chapters 必须是章节数组（[{ heading, paragraphs }]），实得 ${typeof chapters}`)
  }
  chapters.forEach((chapter, i) => {
    if (!chapter || typeof chapter !== 'object' || !Array.isArray(chapter.paragraphs)) {
      const got = chapter?.paragraphs === null ? 'null' : typeof chapter?.paragraphs
      throw new TypeError(`buildEpub: 第 ${i + 1} 章（${chapter?.heading ?? '无标题'}）的 paragraphs 必须是段落数组，实得 ${got}`)
    }
  })
  const modified = `${new Date().toISOString().replace(/\.\d{3}Z$/, '')}Z`
  const entries = [
    // mimetype 必须第一个条目且 stored、内容不带换行——EPUB 规范的身份证
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: containerXml() },
    { name: 'OEBPS/content.opf', data: contentOpf({ title, author, uuid, chapters, modified }) },
    { name: 'OEBPS/nav.xhtml', data: navXhtml({ chapters }) },
    { name: 'OEBPS/style.css', data: STYLE_CSS },
    ...chapters.map((chapter, i) => ({ name: `OEBPS/${chapFile(i)}`, data: chapXhtml(chapter) })),
  ]
  return buildZip(entries)
}
