/**
 * Content-Typ Detektor
 *
 * Erkennt den Typ einer Webseite basierend auf:
 * - DOM-Struktur und Metadaten
 * - URL-Muster
 * - Heuristische Analyse
 *
 * WICHTIG: Deterministisch - gleiche Seite → gleicher Content-Typ
 */

class ContentDetector {
  constructor(config) {
    this.config = config;
  }

  /**
   * Hauptfunktion: Erkennt Content-Typ einer Seite
   *
   * @param {Object} pageData - Daten über die Seite
   * @param {string} pageData.url - URL der Seite
   * @param {Object} pageData.dom - DOM-Informationen (aus Content Script)
   * @param {Object} pageData.meta - Meta-Tags
   * @returns {string} Content-Typ (Key aus CONTENT_TYPE_MULTIPLIERS)
   */
  detectContentType(pageData) {
    const { url, dom, meta } = pageData;

    // 1. Code Repository Erkennung (höchste Priorität)
    if (this.isCodeRepository(url, dom, meta)) {
      return 'CODE_REPOSITORY';
    }

    // 2. Tutorial/Documentation
    if (this.isTutorial(url, dom, meta)) {
      return 'TUTORIAL';
    }

    if (this.isDocumentation(url, dom, meta)) {
      return 'DOCUMENTATION';
    }

    // 3. Interactive Tools
    if (this.isInteractiveTool(url, dom, meta)) {
      return 'TOOL';
    }

    if (this.isPlayground(url, dom, meta)) {
      return 'PLAYGROUND';
    }

    // 4. Media
    if (this.isVideo(url, dom, meta)) {
      return 'VIDEO';
    }

    if (this.isPodcast(url, dom, meta)) {
      return 'PODCAST';
    }

    if (this.isImageGallery(url, dom, meta)) {
      return 'IMAGE_GALLERY';
    }

    // 5. Social/Discussion
    if (this.isSocialFeed(url, dom, meta)) {
      return 'SOCIAL_FEED';
    }

    if (this.isDiscussion(url, dom, meta)) {
      return 'DISCUSSION';
    }

    // 6. Article/Blog
    if (this.isArticle(url, dom, meta)) {
      return 'ARTICLE';
    }

    if (this.isBlogPost(url, dom, meta)) {
      return 'BLOG_POST';
    }

    // Default
    return 'UNKNOWN';
  }

  /**
   * Code Repository Detection
   */
  isCodeRepository(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // GitHub
    if (urlLower.includes('github.com') &&
        (urlLower.match(/\/[^/]+\/[^/]+\/?$/) || // user/repo
         urlLower.includes('/blob/') ||
         urlLower.includes('/tree/'))) {
      return true;
    }

    // GitLab
    if (urlLower.includes('gitlab.com') &&
        urlLower.includes('/-/')) {
      return true;
    }

    // Bitbucket
    if (urlLower.includes('bitbucket.org')) {
      return true;
    }

    // Self-hosted Git (häufige Indikatoren)
    if (dom && (
        dom.hasGitLabUI ||
        dom.hasGiteaUI ||
        (dom.title && dom.title.includes('Git'))
    )) {
      return true;
    }

    return false;
  }

  /**
   * Tutorial Detection
   */
  isTutorial(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // URL-Muster
    if (urlLower.includes('/tutorial') ||
        urlLower.includes('/guide') ||
        urlLower.includes('/how-to') ||
        urlLower.includes('/learn')) {
      return true;
    }

    // Meta-Tags
    if (meta) {
      const ogType = meta['og:type'];
      if (ogType === 'article.tutorial' || ogType === 'tutorial') {
        return true;
      }

      const keywords = meta.keywords || '';
      if (keywords.toLowerCase().includes('tutorial')) {
        return true;
      }
    }

    // DOM-Struktur: Viele Code-Snippets + Schritt-für-Schritt
    if (dom) {
      const hasCodeBlocks = dom.codeBlockCount > 3;
      const hasOrderedSteps = dom.hasOrderedList || dom.hasStepIndicators;

      if (hasCodeBlocks && hasOrderedSteps) {
        return true;
      }
    }

    return false;
  }

  /**
   * Documentation Detection
   */
  isDocumentation(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // URL-Muster
    if (urlLower.includes('/docs') ||
        urlLower.includes('/documentation') ||
        urlLower.includes('/api') ||
        urlLower.includes('/reference')) {
      return true;
    }

    // Bekannte Docs-Plattformen
    if (urlLower.includes('readthedocs.io') ||
        urlLower.includes('gitbook.io') ||
        urlLower.includes('docs.') ||
        urlLower.includes('developer.')) {
      return true;
    }

    // DOM: Sidebar + ToC + Code
    if (dom) {
      if (dom.hasSidebar && dom.hasTableOfContents && dom.codeBlockCount > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Interactive Tool Detection
   */
  isInteractiveTool(url, dom, meta) {
    if (!dom) return false;

    // Viele Input-Felder + Canvas/WebGL
    if ((dom.inputCount > 5 || dom.hasCanvas || dom.hasWebGL) &&
        !this.isSocialFeed(url, dom, meta)) {
      return true;
    }

    // URL-Muster
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/tool') ||
        urlLower.includes('/calculator') ||
        urlLower.includes('/converter')) {
      return true;
    }

    return false;
  }

  /**
   * Playground Detection (Code Playgrounds)
   */
  isPlayground(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // Bekannte Playgrounds
    const playgroundDomains = [
      'codesandbox.io',
      'codepen.io',
      'jsfiddle.net',
      'stackblitz.com',
      'repl.it',
      'glitch.com',
      'playcode.io'
    ];

    if (playgroundDomains.some(domain => urlLower.includes(domain))) {
      return true;
    }

    // URL-Muster
    if (urlLower.includes('/playground') ||
        urlLower.includes('/editor')) {
      return true;
    }

    return false;
  }

  /**
   * Video Detection
   */
  isVideo(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // Video-Plattformen
    if (urlLower.includes('youtube.com') ||
        urlLower.includes('vimeo.com') ||
        urlLower.includes('twitch.tv') ||
        urlLower.includes('/watch')) {
      return true;
    }

    // Meta-Tags
    if (meta) {
      if (meta['og:type'] === 'video' ||
          meta['og:type'] === 'video.other') {
        return true;
      }
    }

    // DOM: Video-Element dominant
    if (dom && dom.hasVideoElement && dom.videoElementLarge) {
      return true;
    }

    return false;
  }

  /**
   * Podcast Detection
   */
  isPodcast(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // Podcast-Plattformen
    if (urlLower.includes('spotify.com/episode') ||
        urlLower.includes('podcasts.apple.com') ||
        urlLower.includes('soundcloud.com')) {
      return true;
    }

    // URL-Muster
    if (urlLower.includes('/podcast')) {
      return true;
    }

    // Meta-Tags
    if (meta) {
      if (meta['og:type'] === 'music.song' ||
          (meta.keywords && meta.keywords.toLowerCase().includes('podcast'))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Image Gallery Detection
   */
  isImageGallery(url, dom, meta) {
    if (!dom) return false;

    // Viele Bilder, wenig Text
    if (dom.imageCount > 10 && dom.textContentLength < 500) {
      return true;
    }

    // URL-Muster
    const urlLower = url.toLowerCase();
    if (urlLower.includes('/gallery') ||
        urlLower.includes('/photos') ||
        urlLower.includes('/images')) {
      return true;
    }

    // Bekannte Plattformen
    if (urlLower.includes('instagram.com') ||
        urlLower.includes('pinterest.com') ||
        urlLower.includes('500px.com') ||
        urlLower.includes('flickr.com')) {
      return true;
    }

    return false;
  }

  /**
   * Social Feed Detection (Doomscrolling!)
   */
  isSocialFeed(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // Social Media Hauptseiten
    const socialDomains = [
      'twitter.com',
      'x.com',
      'facebook.com',
      'instagram.com',
      'tiktok.com',
      'reddit.com/r/', // Subreddits
      'linkedin.com/feed'
    ];

    if (socialDomains.some(domain => urlLower.includes(domain))) {
      // Aber nicht einzelne Posts
      if (!urlLower.includes('/status/') &&
          !urlLower.includes('/post/') &&
          !urlLower.includes('/p/')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Discussion Detection (Foren, Kommentare)
   */
  isDiscussion(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // Forum/Discussion Plattformen
    if (urlLower.includes('stackoverflow.com') ||
        urlLower.includes('stackexchange.com') ||
        urlLower.includes('reddit.com/r/') ||
        urlLower.includes('/forum') ||
        urlLower.includes('/discussion')) {
      return true;
    }

    // DOM: Viele verschachtelte Kommentare
    if (dom && dom.hasThreadedComments) {
      return true;
    }

    return false;
  }

  /**
   * Article Detection
   */
  isArticle(url, dom, meta) {
    if (!meta) return false;

    // Meta-Tags
    if (meta['og:type'] === 'article') {
      return true;
    }

    // Schema.org
    if (meta.schema === 'Article' ||
        meta.schema === 'NewsArticle' ||
        meta.schema === 'BlogPosting') {
      return true;
    }

    // DOM: Langer Text-Content, wenig Interaktivität
    if (dom) {
      if (dom.textContentLength > 1000 && dom.hasArticleTag) {
        return true;
      }
    }

    return false;
  }

  /**
   * Blog Post Detection
   */
  isBlogPost(url, dom, meta) {
    const urlLower = url.toLowerCase();

    // URL-Muster
    if (urlLower.includes('/blog') ||
        urlLower.includes('/post')) {
      return true;
    }

    // Bekannte Blog-Plattformen
    if (urlLower.includes('medium.com') ||
        urlLower.includes('dev.to') ||
        urlLower.includes('hashnode.dev') ||
        urlLower.includes('substack.com')) {
      return true;
    }

    // Meta-Tags
    if (meta && meta.schema === 'BlogPosting') {
      return true;
    }

    return false;
  }

  /**
   * Holt Multiplier für Content-Typ
   */
  getMultiplier(contentType) {
    return this.config.contentTypes[contentType] || this.config.contentTypes.UNKNOWN;
  }
}

// Export für Browser-Extension (non-module)
if (typeof window !== 'undefined') {
  window.ContentDetector = ContentDetector;
}

// Export für Node.js/Tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContentDetector;
}
