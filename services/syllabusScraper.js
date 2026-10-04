import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scrapes syllabus data from a given educational portal URL.
 * Extracts Subjects from H1/H2/H3 tags and sub-topics from adjacent lists or tables.
 *
 * @param {string} url - Target URL of the educational portal/syllabus page
 * @param {string} examName - Name of the exam (e.g. "SSC CGL", "CA Foundation")
 * @returns {Promise<Object>} Formatted object matching Exam schema
 */
export async function scrapeExamSyllabus(url, examName) {
  if (!url || !url.startsWith('http')) {
    throw new Error('Please provide a valid HTTP or HTTPS URL.');
  }

  const cleanedExamName = examName?.trim() || 'Custom Exam';
  const examCode = cleanedExamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove noise scripts, styles, iframes, footers, headers
    $('script, style, iframe, nav, footer, header, noscript, .ads, .comment').remove();

    const subjects = [];

    // Find headings (h2, h3, h4) that could denote subject or section names
    const headings = $('h2, h3, h4');

    headings.each((_, el) => {
      const headingText = $(el)
        .text()
        .trim()
        .replace(/[\r\n\t]+/g, ' ');

      // Filter out utility headings like "FAQ", "Comments", "Share", "Overview"
      if (
        headingText.length < 3 ||
        headingText.length > 90 ||
        /faq|comment|share|related|about us|cookie|disclaimer|download|author/i.test(headingText)
      ) {
        return;
      }

      const subTopics = [];

      // Look at immediate siblings or next elements until next heading
      let nextElem = $(el).next();
      let steps = 0;

      while (nextElem.length && steps < 6) {
        steps++;
        const tagName = nextElem.prop('tagName')?.toLowerCase();

        // If we hit another heading of same or higher level, stop scanning for this subject
        if (['h1', 'h2', 'h3'].includes(tagName)) {
          break;
        }

        // 1. Unordered / Ordered Lists
        if (tagName === 'ul' || tagName === 'ol' || nextElem.find('ul, ol').length) {
          const listItems = nextElem.is('ul, ol')
            ? nextElem.find('li')
            : nextElem.find('ul li, ol li');
          listItems.each((__, li) => {
            const text = $(li)
              .text()
              .trim()
              .replace(/[\r\n\t]+/g, ' ');
            if (text.length > 2 && text.length < 150 && !subTopics.includes(text)) {
              subTopics.push(text);
            }
          });
        }

        // 2. Tables (Topic / Subtopic tables)
        if (tagName === 'table' || nextElem.find('table').length) {
          const rows = nextElem.is('table') ? nextElem.find('tr') : nextElem.find('table tr');
          rows.each((__, row) => {
            const cells = $(row).find('td');
            if (cells.length > 0) {
              // Usually first or second cell contains the topic name
              const cellText = $(cells[0])
                .text()
                .trim()
                .replace(/[\r\n\t]+/g, ' ');
              const cellText2 =
                cells.length > 1
                  ? $(cells[1])
                      .text()
                      .trim()
                      .replace(/[\r\n\t]+/g, ' ')
                  : '';
              const target = cellText.length > 3 && !/^\d+$/.test(cellText) ? cellText : cellText2;

              if (target.length > 2 && target.length < 150 && !subTopics.includes(target)) {
                subTopics.push(target);
              }
            }
          });
        }

        // 3. Paragraphs with bullet points or semicolon-separated items
        if (tagName === 'p') {
          const pText = nextElem.text().trim();
          if (pText.includes('•') || pText.includes(';') || pText.includes(',')) {
            const splitItems = pText
              .split(/[•;,\n]/)
              .map((s) => s.trim())
              .filter((s) => s.length > 3 && s.length < 100);
            splitItems.forEach((item) => {
              if (!subTopics.includes(item)) subTopics.push(item);
            });
          }
        }

        nextElem = nextElem.next();
      }

      if (subTopics.length > 0) {
        // Clean Subject Title
        const cleanName = headingText
          .replace(/^syllabus for\s+/i, '')
          .replace(/\s+syllabus$/i, '')
          .replace(/^\d+[\.\-\)]\s*/, '')
          .trim();

        // Check if subject already added
        const existing = subjects.find((s) => s.name.toLowerCase() === cleanName.toLowerCase());
        if (!existing) {
          subjects.push({
            name: cleanName,
            subTopics,
          });
        } else {
          // Merge topics
          subTopics.forEach((t) => {
            if (!existing.subTopics.includes(t)) existing.subTopics.push(t);
          });
        }
      }
    });

    // Fallback: If no structured headings had lists, try grabbing all top-level lists
    if (subjects.length === 0) {
      const allLists = $('article ul, main ul, .content ul, .post-content ul, body ul');
      let fallbackIndex = 1;

      allLists.each((_, ul) => {
        const items = [];
        $(ul)
          .find('li')
          .each((__, li) => {
            const text = $(li)
              .text()
              .trim()
              .replace(/[\r\n\t]+/g, ' ');
            if (text.length > 3 && text.length < 140) {
              items.push(text);
            }
          });

        if (items.length >= 3) {
          subjects.push({
            name: `Section ${fallbackIndex++}`,
            subTopics: items,
          });
        }
      });
    }

    if (subjects.length === 0) {
      throw new Error(
        `Could not extract structured topics from ${url}. Ensure the webpage has headings and bulleted topics or tables.`
      );
    }

    // Format subjects with chapter objects matching Exam Schema
    let totalChaptersCount = 0;
    const formattedSubjects = subjects.map((subject, subIdx) => {
      const subjectSlug = subject.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 10);

      const chapters = subject.subTopics.map((topic, topicIdx) => ({
        id: `${examCode}-${subjectSlug}-${subIdx + 1}-${topicIdx + 1}`,
        title: topic,
        estimatedHours: 2,
      }));

      totalChaptersCount += chapters.length;

      return {
        name: subject.name,
        chapters,
        subTopics: subject.subTopics,
        totalChapters: chapters.length,
      };
    });

    return {
      name: cleanedExamName,
      code: examCode,
      description: `Syllabus for ${cleanedExamName} automatically extracted from ${new URL(url).hostname}`,
      totalChapters: totalChaptersCount,
      subjects: formattedSubjects,
    };
  } catch (error) {
    console.error('Scraping error:', error.message);
    throw new Error(`Failed to scrape syllabus: ${error.message}`);
  }
}
