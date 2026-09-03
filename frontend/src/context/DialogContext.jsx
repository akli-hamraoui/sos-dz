import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const DialogContext = createContext(null)

// Uber-style bottom-sheet/centered modal replacing window.alert/confirm/prompt
// -- native browser dialogs can't be styled, block the whole tab (including
// any pending async work), and read as jarring next to the rest of the UI.
export function DialogProvider({ children }) {
  const { t } = useTranslation()
  const [state, setState] = useState(null) // { type: 'alert'|'confirm'|'prompt', message, defaultValue, resolve }
  const inputRef = useRef(null)
  // A second show*() call while one is already open used to just overwrite
  // `state` outright -- the first call's `resolve` was then never invoked,
  // leaving its awaiting caller (e.g. a double-clicked action) permanently
  // hung. Queueing instead means every call is guaranteed to eventually
  // resolve, one dialog at a time, in the order they were requested.
  const queueRef = useRef([])

  useEffect(() => {
    if (state && state.type === 'prompt' && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [state])

  const enqueue = useCallback((entry) => {
    return new Promise((resolve) => {
      const full = { ...entry, resolve }
      setState((current) => {
        if (current) {
          queueRef.current.push(full)
          return current
        }
        return full
      })
    })
  }, [])

  const showAlert = useCallback((message) => enqueue({ type: 'alert', message }), [enqueue])

  const showConfirm = useCallback((message) => enqueue({ type: 'confirm', message }), [enqueue])

  const showPrompt = useCallback((message, defaultValue = '') => enqueue({ type: 'prompt', message, defaultValue }), [enqueue])

  const finish = (result) => {
    setState((s) => {
      if (s) s.resolve(result)
      return queueRef.current.shift() || null
    })
  }

  const handleOk = () => {
    if (state.type === 'prompt') finish(inputRef.current ? inputRef.current.value : state.defaultValue)
    else if (state.type === 'confirm') finish(true)
    else finish()
  }

  const handleCancel = () => {
    finish(state.type === 'confirm' ? false : state.type === 'prompt' ? null : undefined)
  }

  return (
    <DialogContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}
      {state && (
        <div className="dialog-backdrop" onClick={handleCancel}>
          <div className="dialog-sheet" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <p className="dialog-message">{state.message}</p>
            {state.type === 'prompt' && (
              <input
                ref={inputRef}
                type="text"
                className="dialog-input"
                defaultValue={state.defaultValue}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOk()
                  if (e.key === 'Escape') handleCancel()
                }}
              />
            )}
            <div className="dialog-actions">
              {state.type !== 'alert' && (
                <button type="button" className="btn" onClick={handleCancel}>
                  {t('common.cancel')}
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={handleOk}>
                {t('common.ok')}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(DialogContext)
  if (!ctx) throw new Error('useDialog must be used within DialogProvider')
  return ctx
}
