{
    'name': 'BBSW Thu Chi',
    'version': '17.0.3.0.0',
    'summary': 'Trang chủ & Quản lý Thu Chi',
    'description': """
        Module BBSW bao gồm:
        - Trang chủ launcher với icon ứng dụng (cấu hình được)
        - Redirect về trang chủ sau khi đăng nhập
        - Quản lý các khoản thu (income)
        - Quản lý các khoản chi (expense)
        - Phân loại theo danh mục
    """,
    'author': 'BBSW',
    'category': 'Accounting',
    'depends': ['base', 'mail', 'hr', 'hr_attendance'],
    'data': [
        'security/ir.model.access.csv',
        'data/sequences.xml',
        'views/thuchi_category_views.xml',
        'views/thuchi_record_views.xml',
        'views/business_unit_views.xml',
        'views/payment_method_views.xml',
        'views/thuchi_project_views.xml',
        'views/home_app_views.xml',
        'views/thuchi_menus.xml',
        'views/project_homepage_templates.xml',
        'views/thuchi_page_template.xml',
        'data/default_apps.xml',
    ],
    'assets': {
        'web.assets_backend': [
            'bbsw_thuchi/static/src/css/backend_theme.css',
        ],
    },
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
}
