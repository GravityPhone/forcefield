import { ref } from 'vue'

// Easter egg: tapping the chat drawer handle 25 times in a row (see
// ChatDrawer) launches the Clipboard Canvass mini game (CanvassGame,
// mounted lazily in AppShell). This ref is the only wiring between them.
export const canvassGameOpen = ref(false)
