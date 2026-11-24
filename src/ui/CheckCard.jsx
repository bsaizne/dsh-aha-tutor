import { forwardRef, useEffect, useState } from 'react'

import { useApp } from './hooks.js'
import { ItemCard } from './ItemCard.jsx'

// The lesson waits for an answer, but the learner can fold the question down
// to inspect the board. Keeping ItemCard mounted preserves a partial answer.
export const CheckCard = forwardRef(function CheckCard({ item, language, onResult, onContinue, continueLabel }, ref) {
  const { t } = useApp()
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => setCollapsed(false), [item.id])
  const toggleLabel = t(collapsed ? 'checkShow' : 'checkHide')

  return <div ref={ref} className="aha-checkCard" data-collapsed={collapsed ? 'true' : 'false'}>
    <div className="aha-spread aha-checkHead">
      <b>{t('checkTitle')}</b>
      <button type="button" className="aha-btn aha-checkToggle" data-kind="ghost" data-size="sm" aria-expanded={!collapsed} aria-label={toggleLabel} title={toggleLabel} onClick={() => setCollapsed(value => !value)}>
        {collapsed ? '▴' : '▾'} {toggleLabel}
      </button>
    </div>
    <div className="aha-checkBody" hidden={collapsed}>
      <ItemCard item={item} language={language} onResult={onResult} onContinue={onContinue} continueLabel={continueLabel} keyboard={!collapsed} />
    </div>
  </div>
})
