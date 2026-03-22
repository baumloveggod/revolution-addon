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
    // Setup based on pattern type
    switch (this.pattern.type) {
      case 'like-dislike':
        this.setupLikeDislike();
        break;
      case 'upvote-downvote':
        this.setupUpvoteDownvote();
        break;
      case 'star':
        this.setupStar();
        break;
      case 'clap':
        this.setupClap();
        break;
      case 'vote':
        this.setupVote();
        break;
    }

    // Setup MutationObserver for dynamic content
    this.setupMutationObserver();
  }

  setupLikeDislike() {
    const checkButtons = () => {
      const likeBtn = document.querySelector(this.pattern.like.selector);
      const dislikeBtn = document.querySelector(this.pattern.dislike.selector);

      if (likeBtn && dislikeBtn) {
        // Check current state
        const likePressed = likeBtn.getAttribute(this.pattern.like.clickedAttr) === this.pattern.like.clickedValue;
        const dislikePressed = dislikeBtn.getAttribute(this.pattern.dislike.clickedAttr) === this.pattern.dislike.clickedValue;

        if (likePressed) {
          this.setRating(5); // Like = 5 stars
        } else if (dislikePressed) {
          this.setRating(1); // Dislike = 1 star
        }

        // Add click listeners
        likeBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowPressed = likeBtn.getAttribute(this.pattern.like.clickedAttr) === this.pattern.like.clickedValue;
            this.setRating(nowPressed ? 5 : null);
          }, 100);
        });

        dislikeBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowPressed = dislikeBtn.getAttribute(this.pattern.dislike.clickedAttr) === this.pattern.dislike.clickedValue;
            this.setRating(nowPressed ? 1 : null);
          }, 100);
        });

        return true;
      }
      return false;
    };

    // Try immediately and retry with delay
    if (!checkButtons()) {
      setTimeout(checkButtons, 1000);
      setTimeout(checkButtons, 3000);
    }
  }

  setupUpvoteDownvote() {
    const checkButtons = () => {
      const upvoteBtn = document.querySelector(this.pattern.upvote.selector);
      const downvoteBtn = document.querySelector(this.pattern.downvote.selector);

      if (upvoteBtn && downvoteBtn) {
        // Check current state
        const upvoted = upvoteBtn.classList.contains(this.pattern.upvote.clickedClass);
        const downvoted = downvoteBtn.classList.contains(this.pattern.downvote.clickedClass);

        if (upvoted) {
          this.setRating(5); // Upvote = 5 stars
        } else if (downvoted) {
          this.setRating(1); // Downvote = 1 star
        }

        // Add click listeners
        upvoteBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowUpvoted = upvoteBtn.classList.contains(this.pattern.upvote.clickedClass);
            this.setRating(nowUpvoted ? 5 : null);
          }, 100);
        });

        downvoteBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowDownvoted = downvoteBtn.classList.contains(this.pattern.downvote.clickedClass);
            this.setRating(nowDownvoted ? 1 : null);
          }, 100);
        });

        return true;
      }
      return false;
    };

    if (!checkButtons()) {
      setTimeout(checkButtons, 1000);
      setTimeout(checkButtons, 3000);
    }
  }

  setupStar() {
    const checkButton = () => {
      const starBtn = document.querySelector(this.pattern.star.selector);

      if (starBtn) {
        // Check if already starred
        const isStarred = starBtn.getAttribute(this.pattern.star.clickedAttr)?.includes(this.pattern.star.clickedValue) ||
                         starBtn.textContent?.includes(this.pattern.star.clickedText);

        if (isStarred) {
          this.setRating(5); // Star = 5 stars
        }

        // Add click listener
        starBtn.addEventListener('click', () => {
          setTimeout(() => {
            const nowStarred = starBtn.getAttribute(this.pattern.star.clickedAttr)?.includes(this.pattern.star.clickedValue) ||
                              starBtn.textContent?.includes(this.pattern.star.clickedText);
            this.setRating(nowStarred ? 5 : null);
          }, 100);
        });

        return true;
      }
      return false;
    };

    if (!checkButton()) {
      setTimeout(checkButton, 1000);
      setTimeout(checkButton, 3000);
    }
  }

  setupClap() {
    const checkButton = () => {
      const clapBtn = document.querySelector(this.pattern.clap.selector);

      if (clapBtn) {
        // Add click listener
        clapBtn.addEventListener('click', () => {
          setTimeout(() => {
            const countElem = document.querySelector(this.pattern.clap.countSelector);
            const count = countElem ? parseInt(countElem.textContent) || 0 : 0;
            if (count > 0) {
              this.setRating(5); // Clapped = 5 stars
            }
          }, 100);
        });

        return true;
      }
      return false;
    };

    if (!checkButton()) {
      setTimeout(checkButton, 1000);
      setTimeout(checkButton, 3000);
    }
  }

  setupVote() {
    // Similar to upvote-downvote
    this.setupUpvoteDownvote();
  }

  setupMutationObserver() {
    // Observe DOM changes for dynamic content
    const observer = new MutationObserver((mutations) => {
      // Re-run detection if new nodes added
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          this.setupDetection();
          break;
        }
      }
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

// Export
if (typeof window !== 'undefined') {
  window.NativeRatingDetector = NativeRatingDetector;
  window.nativeRatingDetector = nativeRatingDetector;
}

