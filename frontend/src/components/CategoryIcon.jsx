import { categoryIconHtml } from '../signali'

// A Signali category's icon (emoji, or a drawing when no emoji fits, e.g.
// the sewer's plumbing pipe). The HTML is a fixed string from signali.js.
export default function CategoryIcon({ category, className = '' }) {
  return <span className={`signali-cat-icon ${className}`.trim()} aria-hidden="true" dangerouslySetInnerHTML={{ __html: categoryIconHtml(category) }} />
}
