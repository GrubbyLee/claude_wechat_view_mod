#!/usr/bin/env node
// wxmp-preview · 方案 C：miniprogram-simulate 渲染（v1 占位）。
// 计划：用 miniprogram-simulate 在 headless 浏览器里渲染 WXML/WXSS 组件并截图。
// 用法: node simulate-bridge.mjs [--project DIR] [--out PATH]

process.stdout.write(
  JSON.stringify({
    ok: false,
    error:
      '方案 C 的渲染桥尚未实现（v1 占位）：计划用 miniprogram-simulate 在 headless 浏览器渲染 WXML/WXSS。' +
      '当前请使用方案 A（H5）或方案 B（开发者工具）。',
  }) + '\n',
)
