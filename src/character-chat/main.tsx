import React from 'react'
import {createRoot} from 'react-dom/client'
import {CharacterChatApp} from './CharacterChatApp'
import './character-chat.css'
createRoot(document.getElementById('root')!).render(<CharacterChatApp />)
