<script setup lang="ts">
// Add a site, or change one (2026-11-19, second pass).
//
// A site is a PLACE: the grocery store, the campus quad, the library steps.
// It exists apart from any shift, so a manager can build the list of places
// the campaign works before deciding who stands where on which day, and the
// same place keeps its history across every day it is used.
import { ref, watch } from 'vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import type { SiteRow } from '@/lib/registration'

const props = defineProps<{
  /** The site being changed, or null to add one. */
  site: SiteRow | null
}>()
const emit = defineEmits<{ saved: []; deleted: []; addShift: [name: string] }>()
const open = defineModel<boolean>('open', { required: true })

const auth = useAuthStore()

const name = ref('')
const address = ref('')
const notes = ref('')
const saving = ref(false)
const error = ref('')
const deleteArmed = ref(false)

watch(open, (isOpen) => {
  if (!isOpen) return
  error.value = ''
  deleteArmed.value = false
  name.value = props.site?.name ?? ''
  address.value = props.site?.address ?? ''
  notes.value = props.site?.notes ?? ''
})

async function save() {
  const cid = auth.profile?.campaign_id
  const siteName = name.value.trim()
  if (!cid || !auth.profile) return
  if (!siteName) {
    error.value = 'Give the site a name.'
    return
  }
  saving.value = true
  error.value = ''
  const fields = { name: siteName, address: address.value.trim() || null, notes: notes.value.trim() || null }
  const { error: e } = props.site
    ? await supabase.from('sites').update(fields).eq('id', props.site.id)
    : await supabase.from('sites').insert({ ...fields, campaign_id: cid, created_by: auth.profile.id })
  saving.value = false
  if (e) {
    error.value = 'Could not save. Try again.'
    return
  }
  open.value = false
  emit('saved')
}

// Two taps, no dialog. Deleting a place takes its shifts with it (the
// schedule is about the place); registrations already counted there are
// kept, they just stop pointing at a site.
async function remove() {
  if (!props.site) return
  if (!deleteArmed.value) {
    deleteArmed.value = true
    return
  }
  saving.value = true
  const { error: e } = await supabase.from('sites').delete().eq('id', props.site.id)
  saving.value = false
  if (e) {
    error.value = 'Could not delete. Try again.'
    return
  }
  open.value = false
  emit('deleted')
}

function planShift() {
  if (!props.site) return
  const siteName = props.site.name
  open.value = false
  emit('addShift', siteName)
}
</script>

<template>
  <BottomSheet v-model:open="open" :title="site ? 'Edit site' : 'Add site'">
    <div class="site-form">
      <div class="field">
        <label for="site-name">Name</label>
        <input id="site-name" v-model="name" type="text" placeholder="Public library, front steps" autocomplete="off" />
      </div>
      <div class="field">
        <label for="site-address">Address</label>
        <input id="site-address" v-model="address" type="text" autocomplete="off" />
      </div>
      <div class="field">
        <label for="site-notes">Notes</label>
        <textarea id="site-notes" v-model="notes" rows="2" placeholder="Who gave permission, where to set up" />
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>

      <div class="actions">
        <button class="btn btn-primary grow" :disabled="saving" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
        <button v-if="site" class="btn delete-btn" :class="{ armed: deleteArmed }" :disabled="saving" @click="remove">
          {{ deleteArmed ? (site.shifts ? `Delete with ${site.shifts} shifts?` : 'Delete?') : 'Delete' }}
        </button>
      </div>
      <button v-if="site" class="btn" :disabled="saving" @click="planShift">+ Add a shift here</button>
    </div>
  </BottomSheet>
</template>

<style scoped>
.site-form {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.site-form .field {
  margin-bottom: 0.15rem;
}

.form-error {
  margin: 0;
  color: var(--danger);
  font-weight: 600;
}

.actions {
  display: flex;
  gap: 0.6rem;
}

.grow {
  flex: 1;
}

.delete-btn {
  border: 1.5px solid var(--danger);
  color: var(--danger);
  background: transparent;
  white-space: normal;
}

.delete-btn.armed {
  background: var(--danger);
  color: #fff;
}
</style>
