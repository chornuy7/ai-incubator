import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { useApp } from '@/mocks/store'
import { installFetchAuth } from '@/shared/lib/fetchAuth'
import { installTooltips } from '@/shared/lib/tooltips'

// Токен сессии — на КАЖДЫЙ запрос к /api (иначе прод-замок 401-ит прямые fetch).
installFetchAuth()

// Подсказки одного вида на всё приложение вместо нативных плашек браузера.
installTooltips()

// Применяем сохранённую тему до первого рендера
const theme = useApp.getState().theme
document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.classList.toggle('light', theme === 'light')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)
