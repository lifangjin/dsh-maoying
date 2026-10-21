/**
 * yaml-loader —— dsh home 定位与 yaml 包的惰性加载
 *
 * 从 index.mjs 迁出的两个环境探测函数：index.mjs（安装器）与
 * lib/panel-core.mjs（创作台）两侧共用，避免 panel-core 反向 import 主入口
 * 造成循环。只做「找 dsh home」「从它的 node_modules 借 yaml 包」两件事，
 * 全程只读、零 npm 依赖——yaml 包本身是宿主 dsh 自带的。
 */

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根（本文件位于 <包根>/lib/ 下，向上一级即包根）。 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * DSH_HOME 环境变量优先（支持 ~ 前缀：环境变量不经过 shell 展开，`~/xxx`
 * 或裸 `~` 在这里手动展开为真实家目录，避免拼出相对当前目录的「字面 ~」
 * 不可用路径），缺省 ~/.dsh。
 */
export function resolveDshHome(env = process.env) {
  const fromEnv = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv === '') return path.join(os.homedir(), '.dsh')
  if (fromEnv === '~' || fromEnv.startsWith('~/')) {
    return path.join(os.homedir(), fromEnv.slice(1))
  }
  return fromEnv
}

/**
 * 从 <home>/node_modules 惰性加载 yaml 包（dsh 自带 v2）。主路径失败再试
 * 插件包自身解析（开发检出偶然落在有 yaml 的目录里时白捡）；两处都没有
 * 返回 null——调用方走回退分支。
 */
export function loadYamlLib(dshHome) {
  for (const base of [
    path.join(dshHome, 'node_modules', 'package.json'),
    path.join(PLUGIN_ROOT, 'package.json'),
  ]) {
    try {
      const mod = createRequire(base)('yaml')
      if (mod && typeof mod.parse === 'function' && typeof mod.stringify === 'function') return mod
    } catch {
      /* 该路径没有 yaml 包——试下一个 */
    }
  }
  return null
}
