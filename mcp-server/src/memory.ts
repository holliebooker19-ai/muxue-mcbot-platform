// 记忆的实现在运行端 client-runtime/src/memory.ts（ServerBody 和这里的旧 Mineflayer 路径共用一份，docs/memory_plan.md）。
// 这里只转出它构建好的版本：先构建 client-runtime（本包的 npm run build 会先做）。
export * from '../../client-runtime/dist/memory.js';
