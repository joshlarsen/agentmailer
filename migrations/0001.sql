CREATE TABLE agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT UNIQUE NOT NULL,disabled INTEGER DEFAULT 0,mailbox_limit INTEGER NOT NULL, daily_limit INTEGER NOT NULL);
CREATE TABLE mailboxes(id TEXT PRIMARY KEY,agent TEXT NOT NULL REFERENCES agents(id),address TEXT UNIQUE NOT NULL,disabled INTEGER DEFAULT 0);
CREATE TABLE keys(id TEXT PRIMARY KEY,mailbox TEXT NOT NULL REFERENCES mailboxes(id),hash TEXT UNIQUE NOT NULL,revoked INTEGER DEFAULT 0);
CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,mailbox TEXT NOT NULL REFERENCES mailboxes(id),direction TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,subject TEXT, sender TEXT, recipient TEXT,object_key TEXT NOT NULL,read INTEGER DEFAULT 0, digest TEXT,idem TEXT,request_hash TEXT,provider_id TEXT,error TEXT,UNIQUE(mailbox,digest),UNIQUE(mailbox,idem));
CREATE INDEX inbox ON messages(mailbox,seq);
CREATE INDEX cleanup ON messages(status,created);
CREATE TABLE usage(mailbox TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(mailbox,day));
CREATE TABLE publication_counter(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
INSERT INTO publication_counter VALUES(1,0);
-- Allocate visibility order on publication, not on the earlier reservation.
CREATE TRIGGER publish_sequence AFTER UPDATE OF status ON messages
WHEN OLD.status='pending' AND NEW.status NOT IN ('pending','deleting')
BEGIN
 UPDATE publication_counter SET value=MAX(value,(SELECT COALESCE(MAX(seq),0) FROM messages))+1 WHERE id=1;
 UPDATE messages SET seq=(SELECT value FROM publication_counter WHERE id=1) WHERE id=NEW.id;
END;
