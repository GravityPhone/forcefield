// vue-advanced-chat's package.json "types" field points at a file that
// doesn't exist in the published package (types/vue-advanced-chat.common.d.ts
// vs the actual types/index.d.ts) — declare just what we use here rather
// than relying on that broken resolution.
declare module 'vue-advanced-chat' {
  export function register(): void
}
