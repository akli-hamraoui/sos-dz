import { useTranslation } from 'react-i18next'
import { MAX_SIGNALI_CATEGORIES, SIGNALI_CATEGORIES, toggleCategory } from '../signali'
import CategoryIcon from './CategoryIcon'

// Signali types as chips, up to MAX_SIGNALI_CATEGORIES at once: the order
// they're picked in shows as 1, 2, 3 (1 = the main type, its map icon).
export default function CategoryPicker({ value, onChange }) {
  const { t } = useTranslation()
  const full = value.filter((c) => c !== 'other').length >= MAX_SIGNALI_CATEGORIES
  return (
    <>
      <div className="signali-categories" role="group" aria-label={t('signali.categoryLabel')}>
        {SIGNALI_CATEGORIES.map((c) => {
          const index = value.indexOf(c)
          const on = index !== -1
          return (
            <button
              key={c}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={on ? 'selected' : ''}
              disabled={!on && full && c !== 'other'}
              onClick={() => onChange(toggleCategory(value, c))}
            >
              <CategoryIcon category={c} /> {t(`signali.categories.${c}`)}
              {on && c !== 'other' && value.length > 1 && <b className="signali-category-rank">{index + 1}</b>}
            </button>
          )
        })}
      </div>
      <small className="signali-hint">{t('signali.categoriesHint', { max: MAX_SIGNALI_CATEGORIES })}</small>
    </>
  )
}
