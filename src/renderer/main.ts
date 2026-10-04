import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import PetWindow from './PetWindow.vue'
import ReminderBubble from './ReminderBubble.vue'
import './style.css'

const view = new URLSearchParams(window.location.search).get('view')
const component = view === 'pet' ? PetWindow : view === 'bubble' ? ReminderBubble : App
// Frameless overlay windows must not inherit the document title, or the
// window caption text can surface on top of the pet.
if (view === 'pet' || view === 'bubble') {
  document.title = ''
  document.documentElement.classList.add('overlay-root')
}
createApp(component).use(createPinia()).mount('#app')
