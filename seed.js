import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Exam from './models/Exam.js';
import User from './models/User.js';
import StudyPlan from './models/StudyPlan.js';
import { countLeafNodes } from './utils/recalculate.js';

dotenv.config();

// The Complete GATE CS & IT Syllabus (4-Level Depth: Subject -> Chapter -> Topic -> Subtopic)
export const gateCSFullSyllabus = {
  name: 'GATE - Computer Science & Information Technology',
  totalChapters: 46,
  subjects: [
    {
      subjectName: 'Engineering Mathematics',
      chapters: [
        {
          chapterName: 'Discrete Mathematics',
          topics: [
            {
              title: 'Propositional and First-Order Logic',
              subtopics: [
                { title: 'Equivalence' },
                { title: 'Predicates' },
                { title: 'Quantifiers' },
              ],
            },
            {
              title: 'Sets, Relations, and Functions',
              subtopics: [{ title: 'Partial Orders' }, { title: 'Lattices' }],
            },
            {
              title: 'Graphs',
              subtopics: [{ title: 'Connectivity' }, { title: 'Matching' }, { title: 'Coloring' }],
            },
            {
              title: 'Groups',
              subtopics: [{ title: 'Cyclic Groups' }, { title: 'Abelian Groups' }],
            },
          ],
        },
        {
          chapterName: 'Linear Algebra',
          topics: [
            {
              title: 'Matrices',
              subtopics: [{ title: 'Determinants' }, { title: 'System of Linear Equations' }],
            },
            {
              title: 'Eigenvalues and Eigenvectors',
              subtopics: [{ title: 'LU Decomposition' }, { title: 'Properties of Eigenvalues' }],
            },
          ],
        },
        {
          chapterName: 'Calculus & Probability',
          topics: [
            {
              title: 'Calculus',
              subtopics: [
                { title: 'Limits & Continuity' },
                { title: 'Maxima and Minima' },
                { title: 'Mean Value Theorem' },
              ],
            },
            {
              title: 'Probability',
              subtopics: [
                { title: 'Random Variables' },
                { title: 'Uniform, Normal, Exponential Distributions' },
                { title: 'Poisson & Binomial Distributions' },
                { title: 'Conditional Probability and Bayes Theorem' },
              ],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Digital Logic',
      chapters: [
        {
          chapterName: 'Boolean Algebra',
          topics: [
            {
              title: 'Minimization',
              subtopics: [{ title: 'K-Maps' }, { title: 'SOP and POS forms' }],
            },
            {
              title: 'Logic Gates',
              subtopics: [{ title: 'Universal Gates' }, { title: 'Gate Level Minimization' }],
            },
          ],
        },
        {
          chapterName: 'Combinational Circuits',
          topics: [
            {
              title: 'Data Handling Circuits',
              subtopics: [
                { title: 'Multiplexers (MUX)' },
                { title: 'Demultiplexers' },
                { title: 'Encoders and Decoders' },
              ],
            },
            {
              title: 'Arithmetic Circuits',
              subtopics: [{ title: 'Half/Full Adders' }, { title: 'Subtractors' }],
            },
          ],
        },
        {
          chapterName: 'Sequential Circuits',
          topics: [
            {
              title: 'Storage Elements',
              subtopics: [{ title: 'Latches' }, { title: 'Flip-Flops (SR, JK, D, T)' }],
            },
            {
              title: 'Circuit Design',
              subtopics: [{ title: 'Counters' }, { title: 'Shift Registers' }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Computer Organization and Architecture',
      chapters: [
        {
          chapterName: 'CPU Architecture',
          topics: [
            {
              title: 'Machine Instructions',
              subtopics: [{ title: 'Addressing Modes' }, { title: 'Instruction Formats' }],
            },
            {
              title: 'Control Unit',
              subtopics: [
                { title: 'ALU Design' },
                { title: 'Data Path' },
                { title: 'Hardwired & Microprogrammed Control' },
              ],
            },
          ],
        },
        {
          chapterName: 'Pipelining',
          topics: [
            { title: 'Instruction Pipelining', subtopics: [{ title: 'Stages & Throughput' }] },
            {
              title: 'Hazards',
              subtopics: [
                { title: 'Data Hazards' },
                { title: 'Control Hazards' },
                { title: 'Structural Hazards' },
              ],
            },
          ],
        },
        {
          chapterName: 'Memory & I/O',
          topics: [
            {
              title: 'Memory Hierarchy',
              subtopics: [
                { title: 'Cache Memory Mapping' },
                { title: 'Main Memory' },
                { title: 'Secondary Storage' },
              ],
            },
            {
              title: 'I/O Interfaces',
              subtopics: [{ title: 'Interrupt Mode' }, { title: 'DMA Mode' }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Programming and Data Structures',
      chapters: [
        {
          chapterName: 'Programming in C',
          topics: [
            {
              title: 'C Basics',
              subtopics: [{ title: 'Variables & Data Types' }, { title: 'Control Statements' }],
            },
            {
              title: 'Advanced C',
              subtopics: [
                { title: 'Functions & Recursion' },
                { title: 'Pointers & Arrays' },
                { title: 'Scope Binding' },
              ],
            },
          ],
        },
        {
          chapterName: 'Linear Data Structures',
          topics: [
            {
              title: 'Arrays & Linked Lists',
              subtopics: [{ title: 'Singly Linked Lists' }, { title: 'Doubly Linked Lists' }],
            },
            {
              title: 'Stacks & Queues',
              subtopics: [{ title: 'Stack Operations & Applications' }, { title: 'Queue & Deque' }],
            },
          ],
        },
        {
          chapterName: 'Non-Linear Data Structures',
          topics: [
            {
              title: 'Trees',
              subtopics: [
                { title: 'Binary Search Trees (BST)' },
                { title: 'AVL Trees' },
                { title: 'Binary Heaps' },
                { title: 'Tree Traversals' },
              ],
            },
            {
              title: 'Graphs',
              subtopics: [{ title: 'Graph Representations' }, { title: 'BFS and DFS Traversals' }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Algorithms',
      chapters: [
        {
          chapterName: 'Algorithm Analysis',
          topics: [
            {
              title: 'Complexity',
              subtopics: [
                { title: 'Asymptotic Notations' },
                { title: 'Worst, Average, and Best Case' },
                { title: 'Space and Time Complexity' },
              ],
            },
            {
              title: 'Sorting & Searching',
              subtopics: [
                { title: 'Binary Search' },
                { title: 'Merge Sort & Quick Sort' },
                { title: 'Heap Sort' },
                { title: 'Hashing Techniques' },
              ],
            },
          ],
        },
        {
          chapterName: 'Algorithm Design Techniques',
          topics: [
            {
              title: 'Greedy Approach',
              subtopics: [{ title: 'Fractional Knapsack' }, { title: 'Huffman Coding' }],
            },
            {
              title: 'Dynamic Programming',
              subtopics: [
                { title: '0/1 Knapsack' },
                { title: 'Matrix Chain Multiplication' },
                { title: 'Longest Common Subsequence' },
              ],
            },
            {
              title: 'Divide and Conquer',
              subtopics: [{ title: 'Recurrence Relations' }, { title: 'Master Theorem' }],
            },
          ],
        },
        {
          chapterName: 'Graph Algorithms',
          topics: [
            {
              title: 'Shortest Path',
              subtopics: [{ title: "Dijkstra's Algorithm" }, { title: 'Bellman-Ford Algorithm' }],
            },
            {
              title: 'Spanning Trees',
              subtopics: [{ title: "Prim's Algorithm" }, { title: "Kruskal's Algorithm" }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Theory of Computation',
      chapters: [
        {
          chapterName: 'Regular Languages',
          topics: [
            {
              title: 'Finite Automata',
              subtopics: [
                { title: 'DFA & NFA' },
                { title: 'Regular Expressions' },
                { title: 'Equivalence of NFA and DFA' },
              ],
            },
            {
              title: 'Properties',
              subtopics: [
                { title: 'Pumping Lemma for Regular Languages' },
                { title: 'Closure Properties' },
              ],
            },
          ],
        },
        {
          chapterName: 'Context-Free Languages',
          topics: [
            {
              title: 'Pushdown Automata',
              subtopics: [{ title: 'Context-Free Grammars (CFG)' }, { title: 'PDA Design' }],
            },
            {
              title: 'Properties',
              subtopics: [{ title: 'Pumping Lemma for CFLs' }, { title: 'Closure Properties' }],
            },
          ],
        },
        {
          chapterName: 'Turing Machines & Decidability',
          topics: [
            {
              title: 'Turing Machines',
              subtopics: [{ title: 'TM Models' }, { title: 'Recursively Enumerable Languages' }],
            },
            {
              title: 'Undecidability',
              subtopics: [{ title: 'Halting Problem' }, { title: 'Turing Recognizability' }],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Compiler Design',
      chapters: [
        {
          chapterName: 'Phases of Compiler',
          topics: [
            {
              title: 'Lexical Analysis',
              subtopics: [{ title: 'Tokens & Lexemes' }, { title: 'Role of Regular Expressions' }],
            },
            {
              title: 'Parsing',
              subtopics: [
                { title: 'Top-Down Parsing (LL)' },
                { title: 'Bottom-Up Parsing (LR, SLR, LALR)' },
              ],
            },
          ],
        },
        {
          chapterName: 'Translation & Optimization',
          topics: [
            {
              title: 'Syntax Directed Translation',
              subtopics: [{ title: 'Attributes & Evaluation' }],
            },
            {
              title: 'Code Generation',
              subtopics: [
                { title: 'Intermediate Code' },
                { title: 'Runtime Environments' },
                { title: 'Local Optimization & Data Flow' },
              ],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Operating System',
      chapters: [
        {
          chapterName: 'Process Management',
          topics: [
            {
              title: 'Processes & Threads',
              subtopics: [
                { title: 'System Calls' },
                { title: 'Process Control Block' },
                { title: 'User & Kernel Threads' },
              ],
            },
            {
              title: 'CPU Scheduling',
              subtopics: [{ title: 'FCFS, SJF, SRTF' }, { title: 'Round Robin & Priority' }],
            },
            {
              title: 'Concurrency',
              subtopics: [
                { title: 'Inter-process Communication' },
                { title: 'Semaphores & Mutex' },
                { title: 'Deadlock Prevention, Avoidance, and Detection' },
              ],
            },
          ],
        },
        {
          chapterName: 'Memory & Storage',
          topics: [
            {
              title: 'Memory Management',
              subtopics: [
                { title: 'Paging & Segmentation' },
                { title: 'Virtual Memory & Demand Paging' },
                { title: 'Page Replacement Algorithms' },
              ],
            },
            {
              title: 'File Systems',
              subtopics: [
                { title: 'File Allocation Methods' },
                { title: 'Disk Scheduling (FCFS, SSTF, SCAN)' },
              ],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Databases',
      chapters: [
        {
          chapterName: 'Database Design',
          topics: [
            {
              title: 'ER Model',
              subtopics: [
                { title: 'Entities & Attributes' },
                { title: 'Relationships & Cardinality' },
              ],
            },
            {
              title: 'Relational Model',
              subtopics: [{ title: 'Relational Algebra' }, { title: 'Tuple Calculus' }],
            },
            {
              title: 'Normalization',
              subtopics: [
                { title: 'Functional Dependencies' },
                { title: '1NF, 2NF, 3NF, and BCNF' },
              ],
            },
          ],
        },
        {
          chapterName: 'SQL & Storage',
          topics: [
            {
              title: 'SQL',
              subtopics: [
                { title: 'Queries & Sub-queries' },
                { title: 'Joins & Set Operations' },
                { title: 'Integrity Constraints' },
              ],
            },
            {
              title: 'File Organization',
              subtopics: [{ title: 'Indexing' }, { title: 'B-Trees & B+ Trees' }],
            },
          ],
        },
        {
          chapterName: 'Transactions',
          topics: [
            {
              title: 'Concurrency Control',
              subtopics: [
                { title: 'ACID Properties' },
                { title: 'Serializability' },
                { title: 'Locking Protocols' },
              ],
            },
          ],
        },
      ],
    },
    {
      subjectName: 'Computer Networks',
      chapters: [
        {
          chapterName: 'Network Basics & Link Layer',
          topics: [
            {
              title: 'Concept of Layering',
              subtopics: [
                { title: 'OSI & TCP/IP Models' },
                { title: 'LAN Technologies (Ethernet)' },
              ],
            },
            {
              title: 'Data Link Layer',
              subtopics: [
                { title: 'Framing' },
                { title: 'Error Control & Flow Control' },
                { title: 'MAC Protocols (CSMA/CD)' },
              ],
            },
          ],
        },
        {
          chapterName: 'Network & Transport Layer',
          topics: [
            {
              title: 'Network Layer',
              subtopics: [
                { title: 'IPv4/IPv6 Addressing' },
                { title: 'Subnetting & CIDR' },
                { title: 'Routing Algorithms (Distance Vector, Link State)' },
              ],
            },
            {
              title: 'Transport Layer',
              subtopics: [
                { title: 'TCP & UDP' },
                { title: 'Sockets' },
                { title: 'Congestion Control' },
              ],
            },
          ],
        },
        {
          chapterName: 'Application Layer & Security',
          topics: [
            { title: 'Protocols', subtopics: [{ title: 'DNS, SMTP, POP, FTP, HTTP' }] },
            {
              title: 'Network Security',
              subtopics: [
                { title: 'Basics of Cryptography' },
                { title: 'Authentication Concepts' },
                { title: 'Firewalls' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

export async function seedDatabase() {
  try {
    const PRIMARY_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/exam_tracker';
    const FALLBACK_URI = 'mongodb://127.0.0.1:27010/exam_tracker';

    if (mongoose.connection.readyState === 0) {
      try {
        console.log(`🔄 Connecting to MongoDB at: ${PRIMARY_URI}`);
        await mongoose.connect(PRIMARY_URI, { serverSelectionTimeoutMS: 2000 });
        console.log('🌱 Connected to Primary MongoDB for seeding');
      } catch (err) {
        console.warn(
          `⚠️ Primary MongoDB connection failed (${err.message}). Trying fallback: ${FALLBACK_URI}`
        );
        await mongoose.connect(FALLBACK_URI, { serverSelectionTimeoutMS: 5000 });
        console.log('🌱 Connected to Fallback MongoDB for seeding');
      }
    }

    // 1. Seed / Upsert Default Student User
    let defaultUser = await User.findOne({ email: 'aspirant@studytracker.app' });
    if (!defaultUser) {
      defaultUser = await User.create({
        username: 'Aspirant',
        email: 'aspirant@studytracker.app',
        password: 'password123',
        accountMode: 'self_study',
      });
      console.log('✅ Created default student user:', defaultUser.email);
    } else {
      defaultUser.password = 'password123';
      if (!defaultUser.accountMode) defaultUser.accountMode = 'self_study';
      await defaultUser.save();
    }

    // 2. Seed / Upsert Default Teacher User (Addresses: "teachers login should be there")
    let defaultTeacher = await User.findOne({ email: 'teacher@studytracker.app' });
    if (!defaultTeacher) {
      defaultTeacher = await User.create({
        username: 'Prof. Sharma',
        email: 'teacher@studytracker.app',
        password: 'password123',
        accountMode: 'teacher',
        teacherCode: 'TEACH1',
      });
      console.log(
        '✅ Created default teacher user:',
        defaultTeacher.email,
        'Code:',
        defaultTeacher.teacherCode
      );
    } else {
      defaultTeacher.password = 'password123';
      defaultTeacher.accountMode = 'teacher';
      defaultTeacher.teacherCode = 'TEACH1';
      await defaultTeacher.save();
      console.log('✅ Updated default teacher user:', defaultTeacher.email);
    }

    // 3. Calculate 4-level leaf count (atomic Subtopics)
    const totalLeafNodes = countLeafNodes(gateCSFullSyllabus.subjects);

    // 4. Seed / Upsert the 4-level deep GATE CS Exam
    const seededExam = await Exam.findOneAndUpdate(
      { code: 'gate-cs' },
      {
        name: gateCSFullSyllabus.name,
        code: 'gate-cs',
        description:
          'Graduate Aptitude Test in Engineering for Computer Science & IT (Full 4-Level Syllabus)',
        subjects: gateCSFullSyllabus.subjects,
        totalChapters: gateCSFullSyllabus.totalChapters,
        totalLeafNodes,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log(`✅ Seeded complete 4-level GATE CS Exam with ${totalLeafNodes} atomic subtopics!`);

    // 5. Update or Seed an active StudyPlan for the default student user with the 4-level depth
    let userPlan = await StudyPlan.findOne({ userId: defaultUser._id, status: 'active' });
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 90); // 90 days from now

    // Prepare 4-level deep subjects for StudyPlan with SRS tracking on Subtopics
    const planSubjects = gateCSFullSyllabus.subjects.map((sub) => ({
      subjectName: sub.subjectName,
      name: sub.subjectName,
      chapters: sub.chapters.map((ch) => ({
        chapterName: ch.chapterName,
        title: ch.chapterName,
        topics: ch.topics.map((t) => ({
          title: t.title,
          subtopics: t.subtopics.map((st) => ({
            title: st.title,
            nodeId: `${sub.subjectName}-${ch.chapterName}-${t.title}-${st.title}`,
            isCompleted: false,
            reviewCount: 0,
            nextReviewDate: null,
            lastReviewedAt: null,
          })),
        })),
      })),
    }));

    if (!userPlan) {
      userPlan = await StudyPlan.create({
        userId: defaultUser._id,
        examId: seededExam._id,
        targetDate,
        subjects: planSubjects,
        totalTopics: totalLeafNodes,
        completedTopics: 0,
        completedChapterIds: [],
        studyDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      });
      console.log('✅ Created active 4-level study plan for default user');
    } else {
      userPlan.examId = seededExam._id;
      userPlan.subjects = planSubjects;
      userPlan.totalTopics = totalLeafNodes;
      await userPlan.save();
      console.log('✅ Synchronized active 4-level study plan for default user');
    }

    console.log('🎉 Database seeding complete!');
  } catch (error) {
    console.error('❌ Error seeding database:', error);
  }
}

// Allow direct CLI execution: node seed.js
if (process.argv[1]?.includes('seed.js')) {
  seedDatabase().then(() => {
    console.log('🎉 Seeding script finished.');
    mongoose.connection.close();
    process.exit(0);
  });
}

export default seedDatabase;
