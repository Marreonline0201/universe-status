import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SettingsProvider } from './settings/SettingsContext'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <SettingsProvider>
    <App />
  </SettingsProvider>,
)
