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

  useEffect(() => {
    if (state && state.type === 'prompt' && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [state])

  const showAlert = useCallback(
    (message) =>
      new Promise((resolve) => {
        setState({ type: 'alert', message, resolve })
      }),
    []
  )

  const showConfirm = useCallback(
    (message) =>
      new Promise((resolve) => {
        setState({ type: 'confirm', message, resolve })
      }),
    []
  )

  const showPrompt = useCallback(
    (message, defaultValue = '') =>
      new Promise((resolve) => {
        setState({ type: 'prompt', message, defaultValue, resolve })
      }),
    []
  )

  const finish = (result) => {
    setState((s) => {
      if (s) s.resolve(result)
      return null
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
