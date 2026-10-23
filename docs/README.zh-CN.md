# @adamcjm/dsh-enhancer

[English](../README.md) | 中文

[![npm version](https://img.shields.io/npm/v/@adamcjm/dsh-enhancer.svg)](https://www.npmjs.com/package/@adamcjm/dsh-enhancer)
[![license](https://img.shields.io/npm/l/@adamcjm/dsh-enhancer.svg)](../LICENSE)

一个 [DeepSeek Harness](https://github.com/omdsh-dev/dsh) 插件：补上自带工作区菜单里缺的几个日常操作。
包名按**功能领域**而不是单个功能命名，所以以后继续加菜单增强不需要再改名。

目前提供三项：

| 位置 | 入口 | 作用 |
| --- | --- | --- |
| 工作区行 →「…」菜单 | **打开文件夹** | 用 Finder / 资源管理器 / 系统文件管理器打开该工作区所在目录 |
| 工作区行 →「…」菜单 | **隐藏工作区** / **取消隐藏工作区** | 从侧边栏隐藏该工作区及它名下的全部会话 |
| 侧栏 → 视图选项 | **显示隐藏工作区 (N)** | 重新显示隐藏的工作区，便于逐个恢复 |

设计上只做显示过滤与本地打开：

- 不归档、不取消归档、不重命名、不移动、不置顶、不删除；
- 不改工作区记录、会话日志或归档集合；
- 「打开文件夹」是只读操作：只调用系统文件管理器，不改任何数据；
- 唯一写入的状态是一个很小的 Host 文件（`$DSH_HOME/storages/dsh-enhancer.json`）。

## 安装

```bash
dsh plugin --profile <profile> add @adamcjm/dsh-enhancer
```

或者在 profile 的 `package.json` 里手工接线：

```json
{
  "dependencies": {
    "@adamcjm/dsh-enhancer": "^1.0.0"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@adamcjm/dsh-enhancer"]
    }
  }
}
```

重启 Host（或等 profile 的 live patch 重载）后刷新 Web UI。

### 本地开发

让 profile 指向本地目录而不是 registry：

```json
{
  "dependencies": {
    "@adamcjm/dsh-enhancer": "link:/absolute/path/to/dsh-enhancer"
  },
  "dsh": {
    "profile": {
      "bundles": ["…", "@adamcjm/dsh-enhancer"]
    }
  }
}
```

`npm test` 两部分都是零依赖自检：浏览器半侧在 `vm` 沙箱里用假 DOM 跑，Host 半侧用临时
`DSH_HOME` 和 Node 风格的请求/响应假对象跑。测试**不会**真的拉起文件管理器。

## 使用

### 打开工作区文件夹

点工作区行上的「…」，选 **打开文件夹**。Host 从工作区注册表里取目录并启动：

| 平台 | 命令 |
| --- | --- |
| macOS | `/usr/bin/open <path>` |
| Windows | `explorer.exe <path>` |
| Linux | `xdg-open <path>` |

失败时就地提示，不会静默关掉菜单：

- **目录不存在** —— 注册的目录已被删除（`status()` 为 `missing-dir`）；
- **打开失败** —— 启动器无法拉起，或平台不支持。

页面从不传路径，只传工作区 id，目录由 Host 自己查注册表，所以一个过期的行不可能让 Host
打开任意目录。注册的路径是登记时 `fs.realpath` 规范化后的绝对路径，因此**不受工作区改名影响**
（`rename` 只改显示标题）。

### 隐藏与恢复工作区

1. **工作区行 →「…」菜单 → 隐藏工作区** —— 该行及其所有会话消失；在「显示隐藏工作区」打开时，
   同一项变为 **取消隐藏工作区**。
2. **侧栏 → 视图选项 → 显示隐藏工作区 (N)** —— 持久化开关，打开后所有隐藏工作区重新出现；
   括号里是当前隐藏数量。

隐藏 id 存在 Host 的 `$DSH_HOME/storages/dsh-enhancer.json`，浏览器不保留副本：启动时拉一次，
之后通过 SSE（`/dsh-enhancer/stream`）接收每次变更，因此 Desktop 和 `dsh web`（两个共享同一
`$DSH_HOME` 的 Host 进程）无需刷新即可同步。变更以增量发送，两个客户端隐藏不同工作区不会互相覆盖。

## 实现原理

- **隐藏**不碰 DOM：插件包装 `workspaces.list` 客户端模型（`getSnapshot`/`subscribe`），投影出过滤后的
  快照，侧边栏、搜索结果和 Hero 工作区选择器因此在一处统一生效。隐藏工作区名下的会话被并入一个
  *仅视图层* 的归档集合，避免自带分组把它们甩进 "Ungrouped" —— 归档集合本身不会被写入。
- **菜单项**是 DOM 追加。DSH 0.2.1-rc 里工作区行菜单和视图选项菜单都是硬编码数组、没有 slot，
  所以插件克隆自带菜单项的 class 追加条目，并用 `MutationObserver` 在菜单打开后找到 portal。
- **Host 半侧**负责持久化状态和 `open-workspace` 动作。打开是 detach 的 `spawn`，
  `stdio: 'ignore'`，所以 HTTP 请求在启动器出现后立刻返回。

## 从 `@adamcjm/dsh-workspace-visibility` 升级

本包取代它。隐藏/显示功能完全一致，首次启动会一次性接续旧状态文件，隐藏列表不会丢。

```bash
dsh plugin --profile <profile> remove @adamcjm/dsh-workspace-visibility
dsh plugin --profile <profile> add @adamcjm/dsh-enhancer
```

迁移细节：

- `$DSH_HOME/storages/workspace-visibility.json` 只读一次，内容复制到 `dsh-enhancer.json`，
  旧文件**原样保留**，方便回滚。
- 不要两个包同时启用：各自注入自己的菜单项，工作区菜单里会出现两份重复条目。

## 兼容性

- DSH 0.2.1-rc 或更新（依赖 `workspaceRegistry` Host 服务、`workspaces.list` 客户端模型、
  locale 服务和 `webServer` 路由载体）。
- Host 进程 Node.js 20+。
- macOS / Windows / Linux。「打开文件夹」需要桌面会话；无头 Host 会返回 `open-failed`。
- 打开动作发生在**提供页面的那个 Host** 上。Host 在远程时，文件管理器会开在远端（或失败），
  不会开在你的笔记本上。

## License

MIT
