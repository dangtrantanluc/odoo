--
-- PostgreSQL database dump
--

-- Dumped from database version 16.2
-- Dumped by pg_dump version 16.2

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: department_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.department_enum AS ENUM (
    'IT',
    'HR',
    'SALES',
    'MARKETING',
    'BOARD'
);


ALTER TYPE public.department_enum OWNER TO admin;

--
-- Name: backlog_status_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.backlog_status_enum AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);


ALTER TYPE public.backlog_status_enum OWNER TO admin;

--
-- Name: backlog_statuses; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.backlog_statuses AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);


ALTER TYPE public.backlog_statuses OWNER TO admin;

--
-- Name: project_member_role_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_member_role_enum AS ENUM (
    'MEMBER',
    'LEAD',
    'VIEWER'
);


ALTER TYPE public.project_member_role_enum OWNER TO admin;

--
-- Name: project_member_roles; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_member_roles AS ENUM (
    'member',
    'viewer'
);


ALTER TYPE public.project_member_roles OWNER TO admin;

--
-- Name: project_priorities; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_priorities AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


ALTER TYPE public.project_priorities OWNER TO admin;

--
-- Name: project_priority; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


ALTER TYPE public.project_priority OWNER TO admin;

--
-- Name: project_priority_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


ALTER TYPE public.project_priority_enum OWNER TO admin;

--
-- Name: project_status; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_status AS ENUM (
    'to_do',
    'in_process',
    'done',
    'review'
);


ALTER TYPE public.project_status OWNER TO admin;

--
-- Name: project_status_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_status_enum AS ENUM (
    'PLANNED',
    'IN_PROGRESS',
    'COMPLETED',
    'ON_HOLD',
    'CANCELLED'
);


ALTER TYPE public.project_status_enum OWNER TO admin;

--
-- Name: project_statuses; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.project_statuses AS ENUM (
    'PLANNED',
    'IN_PROGRESS',
    'COMPLETED',
    'ON_HOLD',
    'CANCELED'
);


ALTER TYPE public.project_statuses OWNER TO admin;

--
-- Name: task_priorities; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_priorities AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


ALTER TYPE public.task_priorities OWNER TO admin;

--
-- Name: task_priority; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_priority AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);


ALTER TYPE public.task_priority OWNER TO admin;

--
-- Name: task_priority_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


ALTER TYPE public.task_priority_enum OWNER TO admin;

--
-- Name: task_status; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_status AS ENUM (
    'to_do',
    'in_process',
    'done',
    'review'
);


ALTER TYPE public.task_status OWNER TO admin;

--
-- Name: task_status_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_status_enum AS ENUM (
    'TODO',
    'IN_PROGRESS',
    'REVIEW',
    'DONE'
);


ALTER TYPE public.task_status_enum OWNER TO admin;

--
-- Name: task_statuses; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.task_statuses AS ENUM (
    'TODO',
    'IN_PROGRESS',
    'DONE',
    'REVIEW'
);


ALTER TYPE public.task_statuses OWNER TO admin;

--
-- Name: user_role; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.user_role AS ENUM (
    'ADMIN',
    'CEO',
    'EMPLOYEE',
    'BU_HEAD'
);


ALTER TYPE public.user_role OWNER TO admin;

--
-- Name: user_role_enum; Type: TYPE; Schema: public; Owner: admin
--

CREATE TYPE public.user_role_enum AS ENUM (
    'ADMIN',
    'CEO',
    'EMPLOYEE'
);


ALTER TYPE public.user_role_enum OWNER TO admin;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: admin
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

BEGIN

    NEW.updated_at = CURRENT_TIMESTAMP;

    RETURN NEW;

END;

$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO admin;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bu_memberships; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.bu_memberships (
    id integer NOT NULL,
    bu_id integer,
    user_id integer,
    is_lead boolean DEFAULT false,
    joined_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.bu_memberships OWNER TO admin;

--
-- Name: bu_memberships_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.bu_memberships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.bu_memberships_id_seq OWNER TO admin;

--
-- Name: bu_memberships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.bu_memberships_id_seq OWNED BY public.bu_memberships.id;


--
-- Name: business_units; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.business_units (
    id integer NOT NULL,
    name character varying NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.business_units OWNER TO admin;

--
-- Name: business_units_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.business_units_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.business_units_id_seq OWNER TO admin;

--
-- Name: business_units_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.business_units_id_seq OWNED BY public.business_units.id;


--
-- Name: departments; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.departments (
    id integer NOT NULL,
    name character varying NOT NULL
);


ALTER TABLE public.departments OWNER TO admin;

--
-- Name: departments_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.departments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.departments_id_seq OWNER TO admin;

--
-- Name: departments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.departments_id_seq OWNED BY public.departments.id;


--
-- Name: backlogs; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.backlogs (
    id integer NOT NULL,
    task_id integer NOT NULL,
    user_id integer NOT NULL,
    project_id integer NOT NULL,
    hours numeric(8,2) NOT NULL,
    work_date date NOT NULL,
    description character varying,
    cost_per_hour_snapshot numeric(18,2),
    total_cost_snapshot numeric(18,2),
    status public.backlog_statuses,
    approver_id integer,
    created_at timestamp with time zone DEFAULT now(),
    task_category character varying
);


ALTER TABLE public.backlogs OWNER TO admin;

--
-- Name: backlogs_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.backlogs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.backlogs_id_seq OWNER TO admin;

--
-- Name: backlogs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.backlogs_id_seq OWNED BY public.backlogs.id;


--
-- Name: project_member_rates; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.project_member_rates (
    id integer NOT NULL,
    user_id integer NOT NULL,
    project_id integer NOT NULL,
    cost_per_hour numeric(18,2) NOT NULL,
    effective_from date NOT NULL,
    effective_to date
);


ALTER TABLE public.project_member_rates OWNER TO admin;

--
-- Name: project_member_rates_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.project_member_rates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.project_member_rates_id_seq OWNER TO admin;

--
-- Name: project_member_rates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.project_member_rates_id_seq OWNED BY public.project_member_rates.id;


--
-- Name: project_members; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.project_members (
    id integer NOT NULL,
    project_id integer NOT NULL,
    user_id integer NOT NULL,
    role character varying,
    joined_at timestamp with time zone DEFAULT now()
);


ALTER TABLE public.project_members OWNER TO admin;

--
-- Name: project_members_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.project_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.project_members_id_seq OWNER TO admin;

--
-- Name: project_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.project_members_id_seq OWNED BY public.project_members.id;


--
-- Name: projects; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.projects (
    id integer NOT NULL,
    owner_id integer,
    name character varying,
    start_date timestamp without time zone,
    end_date timestamp without time zone,
    status public.project_statuses,
    priority public.project_priorities,
    description character varying,
    budget numeric(18,2),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    bu_id integer
);


ALTER TABLE public.projects OWNER TO admin;

--
-- Name: projects_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.projects_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.projects_id_seq OWNER TO admin;

--
-- Name: projects_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.projects_id_seq OWNED BY public.projects.id;


--
-- Name: roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.roles (
    id integer NOT NULL,
    name character varying NOT NULL,
    description text
);


ALTER TABLE public.roles OWNER TO admin;

--
-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.roles_id_seq OWNER TO admin;

--
-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.tasks (
    id integer NOT NULL,
    project_id integer NOT NULL,
    title character varying,
    assignee_id integer,
    status public.task_statuses,
    priority public.task_priorities,
    description text,
    result text,
    issues text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    backlogid integer,
    start_at timestamp without time zone,
    end_at timestamp without time zone
);


ALTER TABLE public.tasks OWNER TO admin;

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tasks_id_seq OWNER TO admin;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.tasks_id_seq OWNED BY public.tasks.id;


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.user_roles (
    user_id integer NOT NULL,
    role_id integer NOT NULL
);


ALTER TABLE public.user_roles OWNER TO admin;

--
-- Name: users; Type: TABLE; Schema: public; Owner: admin
--

CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying,
    username character varying,
    password character varying,
    full_name character varying,
    birthday date,
    avt_url character varying,
    is_active boolean,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    phonenum character varying(11),
    department_id integer
);


ALTER TABLE public.users OWNER TO admin;

--
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: admin
--

CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.users_id_seq OWNER TO admin;

--
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: admin
--

ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;


--
-- Name: bu_memberships id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.bu_memberships ALTER COLUMN id SET DEFAULT nextval('public.bu_memberships_id_seq'::regclass);


--
-- Name: business_units id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.business_units ALTER COLUMN id SET DEFAULT nextval('public.business_units_id_seq'::regclass);


--
-- Name: departments id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.departments ALTER COLUMN id SET DEFAULT nextval('public.departments_id_seq'::regclass);


--
-- Name: backlogs id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs ALTER COLUMN id SET DEFAULT nextval('public.backlogs_id_seq'::regclass);


--
-- Name: project_member_rates id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_member_rates ALTER COLUMN id SET DEFAULT nextval('public.project_member_rates_id_seq'::regclass);


--
-- Name: project_members id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_members ALTER COLUMN id SET DEFAULT nextval('public.project_members_id_seq'::regclass);


--
-- Name: projects id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.projects ALTER COLUMN id SET DEFAULT nextval('public.projects_id_seq'::regclass);


--
-- Name: roles id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tasks ALTER COLUMN id SET DEFAULT nextval('public.tasks_id_seq'::regclass);


--
-- Name: users id; Type: DEFAULT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);


--
-- Data for Name: bu_memberships; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.bu_memberships (id, bu_id, user_id, is_lead, joined_at) FROM stdin;
1	1	5	t	2026-03-03 04:34:07.593981+00
2	3	7	t	2026-03-03 04:34:15.912713+00
3	2	7	t	2026-03-03 04:34:23.292753+00
\.


--
-- Data for Name: business_units; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.business_units (id, name, description, created_at) FROM stdin;
1	AI	team AI	2026-03-03 04:33:38.783049+00
2	Service	team service	2026-03-03 04:33:48.898514+00
3	BA	ba	2026-03-03 04:33:55.793275+00
\.


--
-- Data for Name: departments; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.departments (id, name) FROM stdin;
\.


--
-- Data for Name: backlogs; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.backlogs (id, task_id, user_id, project_id, hours, work_date, description, cost_per_hour_snapshot, total_cost_snapshot, status, approver_id, created_at, task_category) FROM stdin;
1	1	4	1	8.00	2026-01-15	Initial architecture design and documentation	75.00	600.00	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
2	1	4	1	6.50	2026-01-16	Refined architecture based on team feedback	75.00	487.50	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
3	2	4	1	7.00	2026-02-01	Started implementing intent recognition module	75.00	525.00	PENDING	\N	2026-02-23 08:00:08.836035+00	\N
4	3	5	1	5.00	2026-02-10	Set up data collection pipeline	55.00	275.00	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
5	3	5	1	6.00	2026-02-11	Implemented data preprocessing	55.00	330.00	PENDING	\N	2026-02-23 08:00:08.836035+00	\N
6	5	6	3	8.00	2025-11-15	Conducted user interviews	60.00	480.00	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
7	6	6	3	7.50	2026-01-20	Created wireframes for main flows	60.00	450.00	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
8	7	7	3	6.00	2026-02-05	Implemented home screen layout	40.00	240.00	APPROVED	\N	2026-02-23 08:00:08.836035+00	\N
9	7	7	3	5.50	2026-02-06	Added animations and transitions	40.00	220.00	PENDING	\N	2026-02-23 08:00:08.836035+00	\N
\.


--
-- Data for Name: project_member_rates; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.project_member_rates (id, user_id, project_id, cost_per_hour, effective_from, effective_to) FROM stdin;
3	5	1	55.00	2026-01-01	2026-04-11
5	6	1	50.00	2026-01-01	2026-04-11
6	6	3	60.00	2025-11-01	2026-04-11
7	7	2	40.00	2026-02-01	2026-04-11
8	7	3	40.00	2025-11-01	2026-04-11
9	7	4	45.00	2026-01-15	2026-04-11
1	2	1	75.00	2026-01-01	2026-04-11
2	2	3	70.00	2025-11-01	2026-04-11
4	5	2	55.00	2026-01-01	2026-11-11
\.


--
-- Data for Name: project_members; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.project_members (id, project_id, user_id, role, joined_at) FROM stdin;
1	1	4	DEV	2026-02-23 08:00:08.76721+00
2	1	5	DEV	2026-02-23 08:00:08.76721+00
3	1	6	DESIGNER	2026-02-23 08:00:08.76721+00
4	2	5	DEV	2026-02-23 08:00:08.76721+00
5	2	7	DEV	2026-02-23 08:00:08.76721+00
6	3	6	DESIGNER	2026-02-23 08:00:08.76721+00
7	3	7	DEV	2026-02-23 08:00:08.76721+00
8	3	4	PM	2026-02-23 08:00:08.76721+00
9	4	7	DEV	2026-02-23 08:00:08.76721+00
10	1	1	member	2026-03-04 06:53:21.107145+00
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.projects (id, owner_id, name, start_date, end_date, status, priority, description, budget, created_at, updated_at, bu_id) FROM stdin;
4	1	Internal HR System	2026-01-15 00:00:00	2026-04-15 00:00:00	PLANNED	LOW	Develop internal HR management system for employee records	50000.00	2026-02-23 08:00:08.751474+00	2026-03-04 14:42:54.683421+00	3
2	3	Data Analytics Dashboard	2026-02-01 00:00:00	2026-05-31 00:00:00	COMPLETED	MEDIUM	Build a real-time data analytics dashboard for business intelligence	80000.00	2026-02-23 08:00:08.751474+00	2026-03-04 07:54:09.992148+00	2
7	1	WebPM	2026-02-11 00:00:00	2026-11-18 00:00:00	COMPLETED	MEDIUM	wasldkaskldasdasd	150000.00	2026-02-25 07:10:10.885922+00	2026-03-04 07:54:46.474036+00	1
1	3	AI Chatbot Platform	2026-01-01 00:00:00	2026-06-30 00:00:00	ON_HOLD	HIGH	Develop an enterprise AI chatbot platform with NLP capabilities	150000.00	2026-02-23 08:00:08.751474+00	2026-03-04 07:55:10.6073+00	1
5	1	Mobile App Redesign (Copy)	2025-11-01 00:00:00	2026-03-31 00:00:00	IN_PROGRESS	CRITICAL	Complete redesign of the mobile application with new UX/UI	120000.00	2026-02-25 06:59:34.032807+00	2026-03-04 14:41:38.424375+00	1
3	2	Mobile App Redesign	2025-11-01 00:00:00	2026-03-31 00:00:00	PLANNED	CRITICAL	Complete redesign of the mobile application with new UX/UI	120000.00	2026-02-23 08:00:08.751474+00	2026-03-04 14:41:39.968534+00	1
\.


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.roles (id, name, description) FROM stdin;
1	ADMIN	System administrator with full access
2	CEO	Chief Executive Officer - highest level access
4	EMPLOYEE	Regular employee
3	BUHEAD	Business Unit Head - highest authority in their BU
5	bu_head	Business Unit Head
\.


--
-- Data for Name: tasks; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.tasks (id, project_id, title, assignee_id, status, priority, description, result, issues, created_at, updated_at, backlogid, start_at, end_at) FROM stdin;
4	1	UI Design for Chat Interface	6	TODO	MEDIUM	Design the user interface for the chat component	\N	\N	2026-02-23 08:00:08.810616+00	2026-02-27 09:24:10.193407+00	\N	\N	\N
9	2	Chart Components	7	TODO	MEDIUM	Build reusable chart components	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-02 10:50:23.029829+00	\N	\N	\N
17	3	fixbug	5	DONE	MEDIUM	abc	bcd	asdad	2026-03-03 04:15:08.152708+00	2026-03-04 10:23:33.159663+00	\N	2026-03-03 12:00:00	2026-03-03 16:00:00
2	1	Implement Intent Recognition	4	DONE	MEDIUM	Build the intent recognition module using machine learning	aasdasdas	sadsadsad'	2026-02-23 08:00:08.810616+00	2026-03-04 10:23:36.520361+00	\N	2026-03-03 13:38:00	2026-03-03 15:00:00
6	3	Wireframe Design	6	TODO	HIGH	Create wireframes for all screens	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-04 10:24:45.50405+00	\N	\N	\N
7	3	Implement Home Screen	7	DONE	HIGH	Develop the home screen component	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-05 06:53:39.359321+00	\N	2026-03-03 14:30:00	2026-03-03 16:30:00
15	7	change db schema	6	DONE	MEDIUM	change all table and re-structure	\N	\N	2026-02-25 07:10:57.912261+00	2026-03-04 03:01:47.043631+00	\N	\N	\N
10	4	Requirements Analysis	7	REVIEW	MEDIUM	Gather and document requirements from HR team	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-04 03:01:48.18086+00	\N	\N	\N
18	2	test	\N	TODO	MEDIUM	\N	\N	\N	2026-03-04 03:15:19.979392+00	2026-03-04 03:15:19.979392+00	\N	\N	\N
5	3	UX Research	6	TODO	HIGH	Conduct user research and create personas	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-04 03:15:57.829644+00	\N	\N	\N
1	1	Design NLP Architecture	4	TODO	HIGH	Design the natural language processing architecture for the chatbot	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-04 03:15:58.88986+00	\N	\N	\N
3	1	Create Training Data Pipeline	5	TODO	MEDIUM	Set up data pipeline for model training	\N	\N	2026-02-23 08:00:08.810616+00	2026-03-04 03:16:04.832781+00	\N	\N	\N
8	2	Database Schema Design	5	TODO	HIGH	Design database schema for analytics data	asdamsdksadad\n	scadsd	2026-02-23 08:00:08.810616+00	2026-03-04 03:16:05.888924+00	\N	\N	\N
\.


--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.user_roles (user_id, role_id) FROM stdin;
1	1
2	2
3	3
4	4
5	4
6	4
7	4
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: admin
--

COPY public.users (id, email, username, password, full_name, birthday, avt_url, is_active, created_at, updated_at, phonenum, department_id) FROM stdin;
1	admin@bluebolt.com	admin	$2b$12$DA3HgW1Q5PGf.tPXkCLH8OjFNozt.q7CRPZ.LPwCavSyQwRg1aX1i	Admin User	1985-01-15	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
3	hr@bluebolt.com	hrmanager	$2b$12$17sN93wWGjMLEx4vj6lqSecQnSlc7oiVvEC6hQs5MExKJVhIGun4.	HR Manager	1982-03-10	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
4	john.doe@bluebolt.com	johndoe	$2b$12$8h5lN.IR1DKdRLN2ILtZIOAlt8m9S4OFXL1.35MBbavUZtYc24XNu	John Doe	1990-07-25	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
5	jane.smith@bluebolt.com	janesmith	$2b$12$RknR.9TySOcESzmSLPFFqOSJOEXjjyVsNmAomaj5bxrdNKNgfYkca	Jane Smith	1992-11-08	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
6	bob.wilson@bluebolt.com	bobwilson	$2b$12$5xnJ.rgGe389XLwiiBcq0e94xGY.83uPx7jj3bvU03sEGL4QxAG9a	Bob Wilson	1988-04-12	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
7	alice.johnson@bluebolt.com	alicejohnson	$2b$12$Z856UiLLcjOqU/CdrXRz6.tdJJMVkbRZrloVxiYgurvB.SrYV6V5i	Alice Johnson	1995-09-30	\N	t	2026-02-23 08:00:06.294888+00	2026-02-23 08:00:06.294888+00	\N	\N
2	ceo@bluebolt.com	ceo	$2b$12$G3ZFbM0YN9wWZK8NevMxpuVS5OxB3smpHFO.PKE9x3lPNJEDQ/ndS	CEO User	1980-05-20	https://management1.maximus-nhon.online/api/files/file-storage/avatars/2_4c8555ec-0cd6-4cd2-ba63-acd35ab0e2e7.png	t	2026-02-23 08:00:06.294888+00	2026-03-05 06:54:07.583352+00	\N	\N
\.


--
-- Name: bu_memberships_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.bu_memberships_id_seq', 3, true);


--
-- Name: business_units_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.business_units_id_seq', 3, true);


--
-- Name: departments_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.departments_id_seq', 1, false);


--
-- Name: backlogs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.backlogs_id_seq', 22, true);


--
-- Name: project_member_rates_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.project_member_rates_id_seq', 9, true);


--
-- Name: project_members_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.project_members_id_seq', 10, true);


--
-- Name: projects_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.projects_id_seq', 7, true);


--
-- Name: roles_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.roles_id_seq', 5, true);


--
-- Name: tasks_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.tasks_id_seq', 18, true);


--
-- Name: users_id_seq; Type: SEQUENCE SET; Schema: public; Owner: admin
--

SELECT pg_catalog.setval('public.users_id_seq', 7, true);


--
-- Name: bu_memberships bu_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.bu_memberships
    ADD CONSTRAINT bu_memberships_pkey PRIMARY KEY (id);


--
-- Name: business_units business_units_name_key; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.business_units
    ADD CONSTRAINT business_units_name_key UNIQUE (name);


--
-- Name: business_units business_units_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.business_units
    ADD CONSTRAINT business_units_pkey PRIMARY KEY (id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: backlogs backlogs_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs
    ADD CONSTRAINT backlogs_pkey PRIMARY KEY (id);


--
-- Name: user_roles pk_user_roles; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role_id);


--
-- Name: project_member_rates project_member_rates_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_member_rates
    ADD CONSTRAINT project_member_rates_pkey PRIMARY KEY (id);


--
-- Name: project_members project_members_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: bu_memberships uq_bu_user; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.bu_memberships
    ADD CONSTRAINT uq_bu_user UNIQUE (bu_id, user_id);


--
-- Name: project_members uq_user_project; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT uq_user_project UNIQUE (user_id, project_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: ix_departments_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_departments_id ON public.departments USING btree (id);


--
-- Name: ix_departments_name; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX ix_departments_name ON public.departments USING btree (name);


--
-- Name: ix_backlogs_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_backlogs_id ON public.backlogs USING btree (id);


--
-- Name: ix_project_member_rates_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_project_member_rates_id ON public.project_member_rates USING btree (id);


--
-- Name: ix_project_members_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_project_members_id ON public.project_members USING btree (id);


--
-- Name: ix_projects_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_projects_id ON public.projects USING btree (id);


--
-- Name: ix_projects_name; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_projects_name ON public.projects USING btree (name);


--
-- Name: ix_roles_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_roles_id ON public.roles USING btree (id);


--
-- Name: ix_roles_name; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX ix_roles_name ON public.roles USING btree (name);


--
-- Name: ix_tasks_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_tasks_id ON public.tasks USING btree (id);


--
-- Name: ix_tasks_title; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_tasks_title ON public.tasks USING btree (title);


--
-- Name: ix_users_email; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);


--
-- Name: ix_users_id; Type: INDEX; Schema: public; Owner: admin
--

CREATE INDEX ix_users_id ON public.users USING btree (id);


--
-- Name: ix_users_username; Type: INDEX; Schema: public; Owner: admin
--

CREATE UNIQUE INDEX ix_users_username ON public.users USING btree (username);


--
-- Name: bu_memberships bu_memberships_bu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.bu_memberships
    ADD CONSTRAINT bu_memberships_bu_id_fkey FOREIGN KEY (bu_id) REFERENCES public.business_units(id) ON DELETE CASCADE;


--
-- Name: bu_memberships bu_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.bu_memberships
    ADD CONSTRAINT bu_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: backlogs backlogs_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs
    ADD CONSTRAINT backlogs_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.users(id);


--
-- Name: backlogs backlogs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs
    ADD CONSTRAINT backlogs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: backlogs backlogs_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs
    ADD CONSTRAINT backlogs_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);


--
-- Name: backlogs backlogs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.backlogs
    ADD CONSTRAINT backlogs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: project_member_rates project_member_rates_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_member_rates
    ADD CONSTRAINT project_member_rates_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: project_member_rates project_member_rates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_member_rates
    ADD CONSTRAINT project_member_rates_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: project_members project_members_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: project_members project_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.project_members
    ADD CONSTRAINT project_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: projects projects_bu_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_bu_id_fkey FOREIGN KEY (bu_id) REFERENCES public.business_units(id);


--
-- Name: projects projects_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id);


--
-- Name: tasks tasks_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id);


--
-- Name: tasks tasks_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id);


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: users users_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: admin
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);


--
-- PostgreSQL database dump complete
--

