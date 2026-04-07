// AIChatPanel.tsx — Chat interface for AI material generation + auto-experiment

import { useState, useRef, useCallback, useEffect } from 'react'

interface ChatMessage {
  role: 'user' | 'ai' | 'system'
  text: string
  timestamp: number
}

interface AIChatPanelProps {
  onSpawnMaterial: (description: string) => Promise<string>  // returns status message
  onSetTemperature: (temp: number) => void
  autoExperimentActive: boolean
  onToggleAutoExperiment: () => void
  disabled?: boolean
}

export function AIChatPanel({ onSpawnMaterial, onSetTemperature, autoExperimentActive, onToggleAutoExperiment, disabled }: AIChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const addMessage = useCallback((role: ChatMessage['role'], text: string) => {
    setMessages(prev => [...prev, { role, text, timestamp: Date.now() }])
  }, [])

  // Auto-scroll when messages change
  useEffect(() => {
    const el = scrollRef.current
    if (el) {
      setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 50)
    }
  }, [messages])

  // Expose addMessage for external use (auto-experimenter logs)
  // This is done via a ref callback pattern in the parent
  const addMessageRef = useRef(addMessage)
  addMessageRef.current = addMessage

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading || disabled) return
    const text = input.trim()
    setInput('')
    addMessage('user', text)

    // Check for temperature commands
    const tempMatch = text.match(/(?:set |change )?temp(?:erature)?\s*(?:to\s*)?(-?\d+)/i)
    if (tempMatch) {
      const temp = parseInt(tempMatch[1])
      onSetTemperature(temp)
      addMessage('system', `Temperature set to ${temp} C`)
      return
    }

    // Otherwise treat as material spawn
    setLoading(true)
    try {
      const result = await onSpawnMaterial(text)
      addMessage('ai', result)
    } catch (e) {
      addMessage('system', `Error: ${e}`)
    }
    setLoading(false)
  }, [input, loading, disabled, addMessage, onSpawnMaterial, onSetTemperature])

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'rgba(4,8,18,0.8)',
      borderRadius: 0,
      overflow: 'hidden',
      borderTop: '1px solid rgba(0,180,255,0.1)',
    }}>
      {/* Header */}
      <div style={{
        padding: '6px 10px',
        borderBottom: '1px solid rgba(0,180,255,0.1)',
        fontSize: 9,
        fontWeight: 700,
        color: 'rgba(0,180,255,0.5)',
        letterSpacing: 2,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>AI CHAT</span>
        <button
          onClick={onToggleAutoExperiment}
          disabled={disabled}
          style={{
            background: autoExperimentActive ? 'rgba(255,60,60,0.15)' : 'rgba(0,180,255,0.08)',
            border: `1px solid ${autoExperimentActive ? 'rgba(255,60,60,0.3)' : 'rgba(0,180,255,0.2)'}`,
            borderRadius: 3,
            padding: '2px 8px',
            fontSize: 8,
            letterSpacing: 1,
            color: autoExperimentActive ? '#ff6666' : 'rgba(0,180,255,0.5)',
            cursor: disabled ? 'default' : 'pointer',
            fontFamily: 'inherit',
          }}
        >
          AUTO {autoExperimentActive ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: 8,
        fontSize: 10,
        lineHeight: 1.6,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}>
        {disabled && messages.length === 0 && (
          <div style={{
            color: 'rgba(100,150,200,0.35)',
            fontSize: 9,
            textAlign: 'center',
            padding: '16px 8px',
            lineHeight: 1.8,
          }}>
            Enter Anthropic API key to enable AI features
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{
            padding: '4px 8px',
            borderRadius: 3,
            background: msg.role === 'user'
              ? 'rgba(0,180,255,0.06)'
              : msg.role === 'ai'
                ? 'rgba(0,255,136,0.06)'
                : 'rgba(255,170,0,0.06)',
            border: `1px solid ${
              msg.role === 'user'
                ? 'rgba(0,180,255,0.1)'
                : msg.role === 'ai'
                  ? 'rgba(0,255,136,0.1)'
                  : 'rgba(255,170,0,0.1)'
            }`,
          }}>
            <span style={{
              fontWeight: 600,
              fontSize: 8,
              letterSpacing: 1,
              color: msg.role === 'user'
                ? 'rgba(0,180,255,0.6)'
                : msg.role === 'ai'
                  ? 'rgba(0,255,136,0.6)'
                  : 'rgba(255,170,0,0.6)',
            }}>
              {msg.role === 'user' ? 'YOU' : msg.role === 'ai' ? 'AI' : 'SYS'}
            </span>
            {' '}
            <span style={{ color: msg.role === 'system' ? 'rgba(255,170,0,0.7)' : '#c0d0e0' }}>
              {msg.text}
            </span>
          </div>
        ))}
        {loading && (
          <div style={{
            color: 'rgba(0,180,255,0.4)',
            fontSize: 9,
            letterSpacing: 1,
            padding: '4px 8px',
          }}>
            AI thinking...
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{
        padding: 6,
        borderTop: '1px solid rgba(0,180,255,0.1)',
        display: 'flex',
        gap: 4,
      }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder={disabled ? 'API key required...' : 'add salt, pour lava...'}
          disabled={disabled || loading}
          style={{
            flex: 1,
            background: 'rgba(0,180,255,0.04)',
            border: '1px solid rgba(0,180,255,0.15)',
            borderRadius: 3,
            padding: '4px 8px',
            color: '#c0d0e0',
            fontSize: 10,
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={loading || disabled}
          style={{
            background: 'rgba(0,180,255,0.08)',
            border: '1px solid rgba(0,180,255,0.2)',
            borderRadius: 3,
            padding: '4px 10px',
            color: disabled ? 'rgba(100,150,200,0.3)' : 'rgba(0,180,255,0.6)',
            fontSize: 9,
            fontFamily: 'inherit',
            letterSpacing: 1,
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          SEND
        </button>
      </div>
    </div>
  )
}

// Export addMessage type for parent component use
export type { ChatMessage }
