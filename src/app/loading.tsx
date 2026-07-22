/** V0.32 · 状态反馈：路由级骨架屏，避免动态列表页白屏等待。 */
export default function Loading() {
  return (
    <div className="skeleton-page" aria-busy="true" aria-label="页面加载中">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-bar" />
      <div className="skeleton skeleton-card" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
    </div>
  );
}
