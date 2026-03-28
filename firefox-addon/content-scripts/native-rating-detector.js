/**
 * Revolution Native Rating Detector
 *
 * Detectiert und trackt native Website-Ratings:
 * - YouTube: Like/Dislike Buttons
 * - Reddit: Upvote/Downvote
 * - GitHub: Stars
 * - Medium: Claps
 * - Stack Overflow: Votes
 * - E-Commerce: Product Ratings
 *
 * Version: 2.0.0
 */

/**
 * Pattern Library für gängige Websites
 */
const RATING_PATTERNS = {
  'youtube.com': {
    type: 'like-dislike',
    like: {
      selector: 'ytd-toggle-button-renderer#like-button button, like-button-view-model button',
      clickedAttr: 'aria-pressed',
      clickedValue: 'true'
    },
    dislike: {
      selector: 'ytd-toggle-button-renderer#dislike-button button, dislike-button-view-model button',
      clickedAttr: 'aria-pressed',
      clickedValue: 'true'
    }
  },

  'reddit.com': {
    type: 'upvote-downvote',
    upvote: {
      selector: 'button[aria-label*="upvote"], shreddit-post [slot="upvote"]',
      clickedClass: 'fill-upvote-background-active'
    },
    downvote: {
      selector: 'button[aria-label*="downvote"], shreddit-post [slot="downvote"]',
      clickedClass: 'fill-downvote-background-active'
    }
  },

  'github.com': {
    type: 'star',
    star: {
      selector: 'button[aria-label*="Star"], form[action*="/unstar"] button',
      clickedText: 'Starred',
      clickedAttr: 'aria-label',
      clickedValue: 'Unstar'
    }
  },

  'medium.com': {
    type: 'clap',
    clap: {
      selector: 'button[data-action="show-clappers"], button[aria-label*="clap"]',
      countSelector: 'button[data-action="show-clappers"] span'
    }
  },

  'stackoverflow.com': {
    type: 'vote',
    upvote: {
      selector: 'button[aria-label*="Up vote"]',
      clickedClass: 'fc-theme-primary'
    },
    downvote: {
      selector: 'button[aria-label*="Down vote"]',
      clickedClass: 'fc-theme-primary'
    }
  },

  'stackexchange.com': {
    type: 'vote',
    upvote: {
      selector: 'button[aria-label*="Up vote"]',
      clickedClass: 'fc-theme-primary'
    },
    downvote: {
      selector: 'button[aria-label*="Down vote"]',
      clickedClass: 'fc-theme-primary'
    }
  }
};

/**
 * Native Rating Detector
 */
class NativeRatingDetector {
  constructor() {
    this.domain = this.getDomain();
    this.pattern = this.getPattern();
    this.rating = null;
    this.hasNativeRating = false;
    this.observers = [];
    this._attachedButtons = new WeakSet(); // track buttons with listeners
    this._mutationDebounceTimer = null;    // debounce MutationObserver
    this._buttonsFound = false;            // stop re-setup once buttons are found

    if (this.pattern) {
      this.initialize();
    }
  }

  getDomain() {
    const hostname = window.location.hostname;
    // Extract main domain (e.g., "youtube.com" from "www.youtube.com")
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }
    return hostname;
  }

  getPattern() {
    return RATING_PATTERNS[this.domain];
  }

  initialize() {
    this.hasNativeRating = true;

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        this.setupDetection();
      });
    } else {
      this.setupDetection();
    }
  }

  setupDetection() {
    if (this._buttonsFound) return; // already attached, nothing to do

    let found = false;

    // Setup based on pattern type
    switch (this.pattern.type) {
      case 'like-dislike':
        found = this.setupLikeDislike();
        break;
      case 'upvote-downvote':
        found = this.setupUpvoteDownvote();
        break;
      case 'star':
        found = this.setupStar();
        break;
      case 'clap':
        found = this.setupClap();
        break;
      case 'vote':
        found = this.setupVote();
        break;
    }

    if (found) {
      this._buttonsFound = true;
    }

    // Setup MutationObserver only once
    if (!this.observers.length) {
      this.setupMutationObserver();
    }
  }

  setupLikeDislike() {
    const likeBtn = document.querySelector(this.pattern.like.selector);
    const dislikeBtn = document.querySelector(this.pattern.dislike.selector);

    if (likeBtn && dislikeBtn) {
      const likePressed = likeBtn.getAttribute(this.pattern.like.clickedAttr) === this.pattern.like.clickedValue;
      const dislikePressed = dislikeBtn.getAttribute(this.pattern.dislike.clickedAttr) === this.pattern.dislike.clickedValue;

      if (likePressed) {
        this.setRating(5);
      } else if (dislikePressed) {
        this.setRating(1);
      }

      if (!this._attachedButtons.has(likeBtn)) {
        this._attachedButtons.add(likeBtn);
        likeBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowPressed = likeBtn.getAttribute(this.pattern.like.clickedAttr) === this.pattern.like.clickedValue;
            this.setRating(nowPressed ? 5 : null);
          }, 100);
        });
      }

      if (!this._attachedButtons.has(dislikeBtn)) {
        this._attachedButtons.add(dislikeBtn);
        dislikeBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowPressed = dislikeBtn.getAttribute(this.pattern.dislike.clickedAttr) === this.pattern.dislike.clickedValue;
            this.setRating(nowPressed ? 1 : null);
          }, 100);
        });
      }

      return true;
    }
    return false;
  }

  setupUpvoteDownvote() {
    const upvoteBtn = document.querySelector(this.pattern.upvote.selector);
    const downvoteBtn = document.querySelector(this.pattern.downvote.selector);

    if (upvoteBtn && downvoteBtn) {
      const upvoted = upvoteBtn.classList.contains(this.pattern.upvote.clickedClass);
      const downvoted = downvoteBtn.classList.contains(this.pattern.downvote.clickedClass);

      if (upvoted) {
        this.setRating(5);
      } else if (downvoted) {
        this.setRating(1);
      }

      if (!this._attachedButtons.has(upvoteBtn)) {
        this._attachedButtons.add(upvoteBtn);
        upvoteBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowUpvoted = upvoteBtn.classList.contains(this.pattern.upvote.clickedClass);
            this.setRating(nowUpvoted ? 5 : null);
          }, 100);
        });
      }

      if (!this._attachedButtons.has(downvoteBtn)) {
        this._attachedButtons.add(downvoteBtn);
        downvoteBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowDownvoted = downvoteBtn.classList.contains(this.pattern.downvote.clickedClass);
            this.setRating(nowDownvoted ? 1 : null);
          }, 100);
        });
      }

      return true;
    }
    return false;
  }

  setupStar() {
    const starBtn = document.querySelector(this.pattern.star.selector);

    if (starBtn) {
      const isStarred = starBtn.getAttribute(this.pattern.star.clickedAttr)?.includes(this.pattern.star.clickedValue) ||
                       starBtn.textContent?.includes(this.pattern.star.clickedText);

      if (isStarred) {
        this.setRating(5);
      }

      if (!this._attachedButtons.has(starBtn)) {
        this._attachedButtons.add(starBtn);
        starBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowStarred = starBtn.getAttribute(this.pattern.star.clickedAttr)?.includes(this.pattern.star.clickedValue) ||
                              starBtn.textContent?.includes(this.pattern.star.clickedText);
            this.setRating(nowStarred ? 5 : null);
          }, 100);
        });
      }

      return true;
    }
    return false;
  }

  setupClap() {
    const clapBtn = document.querySelector(this.pattern.clap.selector);

    if (clapBtn) {
      if (!this._attachedButtons.has(clapBtn)) {
        this._attachedButtons.add(clapBtn);
        clapBtn.addEventListener('click', () => {
          setTimeout(() => {
            const countElem = document.querySelector(this.pattern.clap.countSelector);
            const count = countElem ? parseInt(countElem.textContent) || 0 : 0;
            if (count > 0) {
              this.setRating(5);
            }
          }, 100);
        });
      }

      return true;
    }
    return false;
  }

  setupVote() {
    return this.setupUpvoteDownvote();
  }

  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      if (this._buttonsFound) {
        // Buttons already attached — stop observing, we no longer need this
        observer.disconnect();
        return;
      }

      const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
      if (!hasNewNodes) return;

      // Debounce: wait for DOM to settle before re-running detection
      clearTimeout(this._mutationDebounceTimer);
      this._mutationDebounceTimer = setTimeout(() => {
        this.setupDetection();
      }, 300);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.observers.push(observer);
  }

  setRating(rating) {
    if (rating !== this.rating) {
      this.rating = rating;

      // Notify background script
      try {
        browser.runtime.sendMessage({
          type: 'NATIVE_RATING_DETECTED',
          rating: rating,
          domain: this.domain,
          url: window.location.href,
          timestamp: Date.now()
        }).catch(err => {
          console.warn('[Revolution] Failed to send native rating:', err);
        });
      } catch (error) {
        console.warn('[Revolution] Error sending native rating:', error);
      }
    }
  }

  getRating() {
    return this.rating;
  }

  hasNativeRatingSupport() {
    return this.hasNativeRating;
  }

  cleanup() {
    clearTimeout(this._mutationDebounceTimer);
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];
  }
}

// Initialize detector
let nativeRatingDetector = null;

function initNativeRatingDetector() {
  if (!nativeRatingDetector) {
    nativeRatingDetector = new NativeRatingDetector();
  }
  return nativeRatingDetector;
}

// Auto-initialize
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNativeRatingDetector);
} else {
  initNativeRatingDetector();
}

// Cleanup on unload to prevent lingering observers
window.addEventListener('pagehide', () => {
  if (nativeRatingDetector) {
    nativeRatingDetector.cleanup();
  }
});

// Export
if (typeof window !== 'undefined') {
  window.NativeRatingDetector = NativeRatingDetector;
  window.nativeRatingDetector = nativeRatingDetector;
}

