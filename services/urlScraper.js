import axios from 'axios';
import * as cheerio from 'cheerio';
import { randomUUID } from 'crypto';

/**
 * Counts total leaf nodes in a nested tree recursively.
 * A leaf node is any node with no children or empty children array.
 *
 * @param {Array<Object>} nodes
 * @returns {number}
 */
export function countLeafNodes(nodes) {
  if (!nodes || !Array.isArray(nodes) || nodes.length === 0) return 0;
  let count = 0;
  for (const node of nodes) {
    if (node.children && Array.isArray(node.children) && node.children.length > 0) {
      count += countLeafNodes(node.children);
    } else {
      count += 1;
    }
  }
  return count;
}

/**
 * Flattens a nested syllabus tree into backward-compatible subjects & chapters
 * so existing dashboard, recalculation, and progress trackers work seamlessly.
 */
export function flattenTreeToSubjects(tree, examCode) {
  if (!tree || !Array.isArray(tree)) return [];

  return tree.map((subjectNode, sIdx) => {
    const chapters = [];

    // Helper to collect all leaf nodes under this subject as chapters
    function collectLeaves(node, prefix = '') {
      if (!node.children || node.children.length === 0) {
        chapters.push({
          id: node.id || `${examCode}-leaf-${randomUUID().slice(0, 8)}`,
          title: prefix ? `${prefix}: ${node.title}` : node.title,
          estimatedHours: 2,
        });
      } else {
        node.children.forEach((child) => {
          collectLeaves(child, node.type === 'chapter' ? node.title : '');
        });
      }
    }

    if (subjectNode.children && subjectNode.children.length > 0) {
      subjectNode.children.forEach((child) => collectLeaves(child));
    } else {
      // Subject itself is a leaf
      chapters.push({
        id: subjectNode.id || `${examCode}-leaf-${randomUUID().slice(0, 8)}`,
        title: subjectNode.title,
        estimatedHours: 2,
      });
    }

    return {
      name: subjectNode.title,
      chapters,
      subTopics: chapters.map((c) => c.title),
      totalChapters: chapters.length,
    };
  });
}

/**
 * Scrapes standard educational webpage layouts using axios and cheerio.
 * Extracts:
 * - h1/h2 as Subjects
 * - h3 as Chapters
 * - ul/li or tables as Topics/Subtopics
 *
 * @param {string} url - Target webpage URL
 * @param {string} examName - Exam title
 * @returns {Promise<Object>} Formatted object matching nested Exam schema
 */
export async function scrapeUrlToTree(url, examName = 'Custom Exam') {
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
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    // Strip unneeded DOM nodes
    $('script, style, iframe, nav, footer, header, noscript, .ads, .comment, svg, button').remove();

    const tree = [];
    let currentSubject = null;
    let currentChapter = null;

    // Traverse headings and lists in document order
    $('h1, h2, h3, ul, ol, table').each((_, el) => {
      const tagName = el.tagName?.toLowerCase();

      if (tagName === 'h1' || tagName === 'h2') {
        const text = $(el)
          .text()
          .trim()
          .replace(/[\r\n\t]+/g, ' ');
        if (text.length < 3 || text.length > 90) return;
        if (/faq|comment|share|related|about us|cookie|disclaimer|download|author/i.test(text))
          return;

        const cleanSubjectTitle = text
          .replace(/^syllabus for\s+/i, '')
          .replace(/\s+syllabus$/i, '')
          .replace(/^\d+[\.\-\)]\s*/, '')
          .trim();

        currentSubject = {
          id: `subj-${randomUUID().slice(0, 8)}`,
          title: cleanSubjectTitle,
          type: 'subject',
          children: [],
        };
        tree.push(currentSubject);
        currentChapter = null;
      } else if (tagName === 'h3') {
        const text = $(el)
          .text()
          .trim()
          .replace(/[\r\n\t]+/g, ' ');
        if (text.length < 2 || text.length > 100) return;

        // If no subject yet, create a default subject
        if (!currentSubject) {
          currentSubject = {
            id: `subj-${randomUUID().slice(0, 8)}`,
            title: 'General Syllabus',
            type: 'subject',
            children: [],
          };
          tree.push(currentSubject);
        }

        currentChapter = {
          id: `chap-${randomUUID().slice(0, 8)}`,
          title: text.replace(/^\d+[\.\-\)]\s*/, '').trim(),
          type: 'chapter',
          children: [],
        };
        currentSubject.children.push(currentChapter);
      } else if (tagName === 'ul' || tagName === 'ol') {
        const items = [];
        $(el)
          .find('li')
          .each((__, li) => {
            const itemText = $(li)
              .text()
              .trim()
              .replace(/[\r\n\t]+/g, ' ');
            if (itemText.length > 2 && itemText.length < 150) {
              items.push(itemText);
            }
          });

        if (items.length > 0) {
          // If we have an active chapter, these list items are topics/subtopics under the chapter
          if (currentChapter) {
            items.forEach((item) => {
              currentChapter.children.push({
                id: `top-${randomUUID().slice(0, 8)}`,
                title: item,
                type: 'topic',
                children: [],
              });
            });
          } else if (currentSubject) {
            // No chapter, so these list items are chapters directly under the subject
            items.forEach((item) => {
              currentSubject.children.push({
                id: `chap-${randomUUID().slice(0, 8)}`,
                title: item,
                type: 'chapter',
                children: [],
              });
            });
          }
        }
      } else if (tagName === 'table') {
        // Parse table rows
        const rows = $(el).find('tr');
        const items = [];
        rows.each((__, tr) => {
          const cells = $(tr).find('td');
          if (cells.length > 0) {
            const t0 = $(cells[0])
              .text()
              .trim()
              .replace(/[\r\n\t]+/g, ' ');
            const t1 =
              cells.length > 1
                ? $(cells[1])
                    .text()
                    .trim()
                    .replace(/[\r\n\t]+/g, ' ')
                : '';
            const picked = t0.length > 3 && !/^\d+$/.test(t0) ? t0 : t1;
            if (picked.length > 2 && picked.length < 140) {
              items.push(picked);
            }
          }
        });

        if (items.length > 0 && currentSubject) {
          const parent = currentChapter || currentSubject;
          items.forEach((item) => {
            parent.children.push({
              id: `top-${randomUUID().slice(0, 8)}`,
              title: item,
              type: currentChapter ? 'topic' : 'chapter',
              children: [],
            });
          });
        }
      }
    });

    // Fallback if no structured tree was formed
    if (tree.length === 0 || countLeafNodes(tree) === 0) {
      // Find all top lists
      const defaultSubj = {
        id: `subj-${randomUUID().slice(0, 8)}`,
        title: cleanedExamName,
        type: 'subject',
        children: [],
      };

      $('li').each((_, li) => {
        const text = $(li)
          .text()
          .trim()
          .replace(/[\r\n\t]+/g, ' ');
        if (text.length > 3 && text.length < 120 && defaultSubj.children.length < 50) {
          defaultSubj.children.push({
            id: `chap-${randomUUID().slice(0, 8)}`,
            title: text,
            type: 'chapter',
            children: [],
          });
        }
      });

      if (defaultSubj.children.length > 0) {
        tree.push(defaultSubj);
      }
    }

    if (tree.length === 0 || countLeafNodes(tree) === 0) {
      throw new Error(
        `Could not parse structured syllabus from ${url}. Please try pasting the syllabus text directly.`
      );
    }

    const totalLeafNodes = countLeafNodes(tree);
    const subjects = flattenTreeToSubjects(tree, examCode);

    return {
      name: cleanedExamName,
      code: examCode,
      description: `Syllabus for ${cleanedExamName} imported from ${new URL(url).hostname}`,
      totalLeafNodes,
      totalChapters: totalLeafNodes,
      tree,
      subjects,
    };
  } catch (error) {
    console.error('URL Scraper Error:', error.message);
    throw new Error(error.message || 'Failed to scrape syllabus from URL.');
  }
}

/**
 * Parses raw copied PDF or article text into a structured syllabus tree.
 * Detects Roman numerals, letters, bullets, or dashes.
 *
 * @param {string} text - Raw pasted syllabus text
 * @param {string} examName - Exam name
 * @returns {Object} Structured Exam tree
 */
export function parseRawTextToTree(text, examName = 'Custom Exam') {
  if (!text || typeof text !== 'string' || text.trim().length < 10) {
    throw new Error('Please provide at least a few lines of syllabus text to parse.');
  }

  const cleanedExamName = examName?.trim() || 'Custom Exam';
  const examCode = cleanedExamName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const tree = [];
  let currentSubject = null;
  let currentChapter = null;

  for (const line of lines) {
    const isMarkdownH1 = /^#\s+/.test(line);
    const isMarkdownH2 = /^##\s+/.test(line);
    const isMarkdownH3 = /^###\s+/.test(line);

    // Subject indicators: "# Subject", "Unit 1", "Section A", "Paper I", "Module 1", "Subject:", or UPPERCASE short line
    const isSubjectLine =
      isMarkdownH1 ||
      /^(unit|section|paper|module|part)\s+[0-9a-zivx]+/i.test(line) ||
      /^subject\s*:/i.test(line) ||
      (!line.startsWith('#') &&
        line.length < 50 &&
        line === line.toUpperCase() &&
        !line.startsWith('-') &&
        !line.startsWith('•'));

    // Chapter indicators: "## Chapter", "Chapter 1", "1.1", or numbered "1. ", "2. "
    const isChapterLine =
      isMarkdownH2 ||
      /^(chapter)\s+[0-9]+/i.test(line) ||
      /^\d+\.\d+\s+/.test(line) ||
      /^\d+\.\s+[A-Z]/.test(line);

    // Topic bullet indicators: "### Topic", "-", "•", "*", or indented/lettered "(a)", "a."
    const isTopicLine = isMarkdownH3 || /^[-•*]\s+/.test(line) || /^\([a-z0-9]\)\s+/i.test(line);

    if (isSubjectLine && !isMarkdownH2 && !isMarkdownH3) {
      const cleanTitle = line
        .replace(/^#\s+/, '')
        .replace(/^subject\s*:\s*/i, '')
        .trim();

      currentSubject = {
        id: `subj-${randomUUID().slice(0, 8)}`,
        title: cleanTitle,
        type: 'subject',
        children: [],
      };
      tree.push(currentSubject);
      currentChapter = null;
    } else if (isChapterLine && !isMarkdownH3) {
      if (!currentSubject) {
        currentSubject = {
          id: `subj-${randomUUID().slice(0, 8)}`,
          title: 'Core Subject',
          type: 'subject',
          children: [],
        };
        tree.push(currentSubject);
      }
      const cleanTitle = line
        .replace(/^##\s+/, '')
        .replace(/^\d+[\.\-\)]\s*/, '')
        .trim();

      currentChapter = {
        id: `chap-${randomUUID().slice(0, 8)}`,
        title: cleanTitle,
        type: 'chapter',
        children: [],
      };
      currentSubject.children.push(currentChapter);
    } else if (isTopicLine) {
      if (!currentSubject) {
        currentSubject = {
          id: `subj-${randomUUID().slice(0, 8)}`,
          title: 'Core Subject',
          type: 'subject',
          children: [],
        };
        tree.push(currentSubject);
      }
      const parent = currentChapter || currentSubject;
      const cleanTitle = line
        .replace(/^###\s+/, '')
        .replace(/^[-•*]\s*/, '')
        .replace(/^\([a-z0-9]\)\s*/i, '')
        .trim();

      parent.children.push({
        id: `top-${randomUUID().slice(0, 8)}`,
        title: cleanTitle,
        type: currentChapter ? 'topic' : 'chapter',
        children: [],
      });
    } else {
      // General line fallback
      if (!currentSubject) {
        currentSubject = {
          id: `subj-${randomUUID().slice(0, 8)}`,
          title: line,
          type: 'subject',
          children: [],
        };
        tree.push(currentSubject);
      } else {
        const parent = currentChapter || currentSubject;
        parent.children.push({
          id: `top-${randomUUID().slice(0, 8)}`,
          title: line,
          type: currentChapter ? 'topic' : 'chapter',
          children: [],
        });
      }
    }
  }

  const totalLeafNodes = countLeafNodes(tree);
  const subjects = flattenTreeToSubjects(tree, examCode);

  return {
    name: cleanedExamName,
    examName: cleanedExamName,
    code: examCode,
    description: `Syllabus for ${cleanedExamName} parsed from text input`,
    totalLeafNodes,
    totalChapters: totalLeafNodes,
    tree,
    subjects,
  };
}
