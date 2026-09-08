// 本文件需要nginx配置路由解析:遇到js的404请求时,转发响应本文件
(function () {
  const isEndsWitchShtml = location.href.split('#')[0].split('?')[0].endsWith('.shtml');
  if (isEndsWitchShtml) {
    return;
  }
  const url = document.currentScript?.src ?? ' - ';
  // web-portal、web-uniapp 需要实现 window.serverRebuildHook
  // 来处理 SPA 页面打开后发布新版本，下个路由动态加载的 js 的 404 问题
  if (window.serverRebuildHook) {
    window.serverRebuildHook(url);
    return;
  }
  if (window.alertJs404) {
    return;
  }
  window.alertJs404 = true;
  // web-portal、web-uniapp 统一
  const commitId = document.querySelector('meta[name="app-version"]').content;
  window.alert(`正在维护中，请稍后刷新再试. [commit:${commitId ?? 'N/A'}, url: ${url}] `);
})();
// console.log('${jsFileName}@${ips}');
