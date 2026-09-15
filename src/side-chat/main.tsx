import { createRoot } from "react-dom/client"
import { SideChatApp } from "./SideChatApp"
import "./side-chat.css"
createRoot(document.getElementById("root")!).render(<SideChatApp api={window.daemonletSideChat} />)
