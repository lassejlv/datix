SELECT jsonb_build_object(
  'tables', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.name),'[]') FROM (
    SELECT c.relname AS name,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions,
      CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END AS partition_key
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
  ) t),
  'columns', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.table_name,t.position),'[]') FROM (
    SELECT c.relname AS table_name,a.attnum AS position,a.attname AS name,
      format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression,a.attidentity AS identity,a.attgenerated AS generated
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
  ) t),
  'constraints', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.table_name,t.name),'[]') FROM (
    SELECT c.relname AS table_name,k.conname AS name,pg_get_constraintdef(k.oid) AS definition
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public'
  ) t),
  'indexes', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.tablename,t.indexname),'[]') FROM (
    SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public'
  ) t),
  'triggers', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.table_name,t.name),'[]') FROM (
    SELECT c.relname AS table_name,t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled AS enabled
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal
  ) t),
  'functions', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.name,t.arguments),'[]') FROM (
    SELECT p.proname AS name,pg_get_function_identity_arguments(p.oid) AS arguments,pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prokind IN ('f','p')
      AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
  ) t),
  'views', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.name),'[]') FROM (
    SELECT c.relname AS name,c.relkind,c.reloptions,pg_get_viewdef(c.oid,true) AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m')
  ) t),
  'sequences', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.name),'[]') FROM (
    SELECT c.relname AS name,format_type(s.seqtypid,NULL) AS type,s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle,
      owner.relname AS owned_table,a.attname AS owned_column
    FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i')
    LEFT JOIN pg_class owner ON owner.oid=d.refobjid
    LEFT JOIN pg_attribute a ON a.attrelid=owner.oid AND a.attnum=d.refobjsubid
    WHERE n.nspname='public'
  ) t),
  'policies', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.tablename,t.policyname),'[]') FROM (
    SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public'
  ) t),
  'types', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.name),'[]') FROM (
    SELECT y.typname AS name,y.typtype,format_type(y.typbasetype,y.typtypmod) AS base_type,y.typnotnull,y.typdefault,
      (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=y.oid) AS labels,
      (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.contypid=y.oid) AS constraints
    FROM pg_type y JOIN pg_namespace n ON n.oid=y.typnamespace
    WHERE n.nspname='public' AND y.typtype IN ('e','d')
  ) t),
  'extensions', (SELECT jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname) ORDER BY e.extname)
    FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace),
  'dimensions', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.hypertable_name,t.dimension_number),'[]') FROM (
    SELECT hypertable_name,dimension_number,column_name,column_type,dimension_type,time_interval,integer_interval,num_partitions
    FROM timescaledb_information.dimensions WHERE hypertable_schema='public'
  ) t)
)
