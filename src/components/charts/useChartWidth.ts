// Track a chart container's rendered width so SVGs draw in real pixel
// coordinates (text stays undistorted at any size — no preserveAspectRatio
// stretching). ResizeObserver keeps it live through sidebar/rotation changes.
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export function useChartWidth(fallback = 640): { el: Ref<HTMLElement | null>; width: Ref<number> } {
  const el = ref<HTMLElement | null>(null)
  const width = ref(fallback)
  let ro: ResizeObserver | null = null
  onMounted(() => {
    if (!el.value) return
    width.value = el.value.clientWidth || fallback
    ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) width.value = w
    })
    ro.observe(el.value)
  })
  onBeforeUnmount(() => ro?.disconnect())
  return { el, width }
}
