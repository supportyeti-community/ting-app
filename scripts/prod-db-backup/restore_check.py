#!/usr/bin/env python3
"""Compare COPY-dump table row counts with a fully restored disposable PostgreSQL database.

Never logs raw dump rows, user data, role credentials or database URLs.
Use only after the production capture has finished and *only* against loopback.
"""
import argparse
import collections
import os
import re
import subprocess
import sys
from pathlib import Path

REQUIRED = (
    "public.tenants",
    "public.menu_items",
    "public.menu_categories",
    "public.menu_allergen_codes",
    "public.menu_item_allergen_reviews",
    "public.orders",
    "auth.users",
    "supabase_migrations.schema_migrations",
)
HEADER = re.compile(r'^COPY\s+((?:"?\w+"?\.)?"?\w+"?)\s*\(',re.I)

def dump_counts(filename):
    counts=collections.Counter()
    active=None
    for line in Path(filename).open(encoding='utf-8'):
        if active:
            if line.rstrip('\r\n') == r'\.':
                active=None
            else:
                counts[active]+=1
            continue
        m=HEADER.match(line)
        if m:
            active=m.group(1).replace('"','')
            counts.setdefault(active,0)
    if active:
        raise RuntimeError("COPY section missing terminator")
    return counts

def scalar(sql, db_url):
    if not db_url.startswith("postgresql://127.0.0.1:") and not db_url.startswith("postgresql://localhost:"):
        raise RuntimeError("Refusing to query non-loopback restore URL")
    result=subprocess.run(["psql","-X","-q","-t","-A","-v","ON_ERROR_STOP=1","--dbname",db_url,"--command",sql],
                          capture_output=True,text=True,timeout=25,check=True)
    return result.stdout.strip()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--data",required=True)
    parser.add_argument("--db-url",required=True)
    args=parser.parse_args()
    expected=dump_counts(args.data)
    for table in REQUIRED:
        if table not in expected:
            raise RuntimeError("Required COPY table absent: "+table)
        actual=int(scalar("SELECT count(*) FROM "+table+";",args.db_url))
        if actual!=expected[table]:
            raise RuntimeError("RESTORE_COUNT_MISMATCH "+table+" expected="+str(expected[table])+" actual="+str(actual))
        print("RESTORE_COUNT_MATCH "+table+" "+str(actual))
    if expected["supabase_migrations.schema_migrations"]!=29:
        raise RuntimeError("Expected exactly 29 migration records in production backup")
    if expected["public.menu_allergen_codes"]!=23:
        raise RuntimeError("Expected 23 structured allergen code records")
    if expected["public.tenants"]<1 or expected["public.menu_items"]<1 or expected["public.orders"]<1:
        raise RuntimeError("Restored production core table unexpectedly empty")
    if expected["auth.users"]<1:
        raise RuntimeError("Auth users were not preserved")
    catalog=scalar("""
        SELECT count(*) FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public'
          AND c.relname IN ('menu_categories','menu_allergen_codes',
                            'menu_item_allergen_reviews','menu_item_allergen_assessments','menu_import_batches')
          AND c.relrowsecurity AND NOT c.relforcerowsecurity
        """,args.db_url)
    if int(catalog)!=5:
        raise RuntimeError("Not all five FS-01 tables retain ENABLE RLS without FORCE RLS")
    policies=int(scalar("SELECT count(*) FROM pg_policies WHERE schemaname='public';",args.db_url))
    if policies<5:
        raise RuntimeError("Production RLS policies missing from restored schema")
    migrated=scalar("SELECT string_agg(version, ',' ORDER BY version) FROM supabase_migrations.schema_migrations;",args.db_url).split(',')
    if len(migrated)!=29 or len(set(migrated))!=29:
        raise RuntimeError("Migration history is not 29 unique versions")
    if not {'20261116000000','20261117000000'}.issubset(migrated):
        raise RuntimeError("FS-01 migration versions absent after restoration")
    print("DISPOSABLE_RESTORE_CERTIFICATION=PASS migrations=29 rls_tables=5 policies="+str(policies)+" production_writes=0")

if __name__=="__main__":
    try:
        main()
    except Exception as exc:
        print("DISPOSABLE_RESTORE_CERTIFICATION=FAIL "+str(exc),file=sys.stderr)
        sys.exit(1)
